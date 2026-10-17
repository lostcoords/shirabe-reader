require "minitest/autorun"
require "tmpdir"
require "shirabe_reader_pack"

class BuilderTest < Minitest::Test
  include ShirabeReaderPack

  class Source
    attr_reader :dictionaries
    def initialize(dictionary, entries, sentences = [])
      @dictionaries, @entries, @sentences = [dictionary], entries, sentences
    end
    def slugs = dictionaries.map(&:slug)
    def gloss_languages = ["eng", "spa"]
    def versions = [["jmdict", "fixture-1"]]
    def audio_recipe = {baseUrl: "https://example.test/audio"}
    def example_links(maximum:) = {1 => [2]}
    def each_batch(dictionary, batch_size:) = yield(@entries)
    def each_sentence(ids, batch_size:)
      @sentences.each { |sentence| yield sentence if ids.include?(sentence.id) }
    end
  end

  def source(visibility: "official")
    dictionary = Dictionary.new(id: 1, slug: "jmdict", kind: "definition", version: "fixture-1", languages: ["eng", "spa"], visibility: visibility)
    sense = Sense.new(label: "1", depth: 0, contents: [Content.new(kind: "gloss", language: "eng", text: "cat", position: 0, title: nil)], annotations: [], relations: [], restrictions: [], source_tags: [])
    writing = Writing.new(text: "猫", script: "kanji", common: true, tags: [], position: 0, applies_to: ["*"], inflection_class: nil)
    entry = Entry.new(id: 1, dictionary: dictionary, source_id: "100", text: "猫", display_headword: "猫", writings: [writing], readings: [], senses: [sense], source_headwords: [], kanji_metadata: nil, sidecars: {pitch: [], frequencies: [], jlpt: nil})
    sentence = Sentence.new(id: 2, dictionary: dictionary, source_id: "200", text: "猫。", contents: [Content.new(kind: "translation", language: "eng", text: "A cat.", position: 0, title: nil)], tokens: [{"surface" => "猫"}, {"surface" => "。"}])
    Source.new(dictionary, [entry], [sentence])
  end

  def test_archive_and_manifest_are_consumable_without_rails
    Dir.mktmpdir do |directory|
      builder = Builder.new(source: source, output_dir: directory, clock: -> {Time.utc(2026, 10, 17)})
      manifest = builder.export
      artifact = File.join(directory, manifest.fetch(:artifact))
      records = Zlib::GzipReader.open(artifact) { |gzip| gzip.each_line.map { |line| JSON.parse(line) } }
      assert_equal ["header", "sentence", "term"], records.map { |record| record.fetch("type") }
      assert_equal ["cat"], records.last.dig("senses", 0, "glosses", "eng")
      assert_equal ["jmdict:200"], records.last.fetch("examples")
      assert_equal "猫。", records[1].fetch("tokens").map { |token| token.fetch("surface") }.join
      assert_equal Digest::SHA256.file(artifact).hexdigest, manifest.fetch(:sha256)
      assert_equal File.size(artifact), manifest.fetch(:bytes)
      assert_equal "2026-10-17T00:00:00Z", manifest.fetch(:builtAt)
      assert builder.up_to_date?
      assert_equal manifest.fetch(:sha256), builder.export.fetch(:sha256)
      File.write(File.join(directory, "manifest.json"), "{")
      refute builder.up_to_date?
    end
  end

  def test_private_pack_omits_public_source_notices
    Dir.mktmpdir do |directory|
      manifest = Builder.new(source: source(visibility: "personal"), output_dir: directory).export
      assert_empty manifest.fetch(:sources)
      assert_match "account owner", manifest.fetch(:modifications).first
    end
  end
end
