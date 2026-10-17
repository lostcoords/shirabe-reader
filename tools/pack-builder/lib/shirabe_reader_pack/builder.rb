require "digest"
require "fileutils"
require "json"
require "pathname"
require "time"
require "zlib"
require "active_support/core_ext/object/blank"

module ShirabeReaderPack
  class Builder
    SCHEMA_VERSION = 7
    DEFAULT_SLUGS = %w[jmdict jmnedict kanjidic].freeze
    GLOSS_LANGUAGES = %w[eng spa].freeze
    CONTENT_KINDS = %w[gloss meaning translation].freeze
    BATCH_SIZE = 500
    EXAMPLES_PER_TERM = 3
    ARTIFACT_PREFIX = "dictionary"
    MANIFEST = "manifest.json"
    # 6 adds `appliesTo` to kana readings. `validateTerm` rejects unknown keys, so
    # a 0.2.0 client would abort installing a recipe-6 pack, hence the gate bump.
    # 7 preserves source-defined Yomitan tags and term/form associations.
    # 8 keys pitch the same way, so a second reading (明日 → あす) has a pattern.
    # 9 drops each pitch row's pre-hashed `audioUrl` for the recipe in the manifest
    # (`audio_recipe`): 40% of the download was SHA-256 digests, which compress to
    # nothing, and adds `sentence` records with the Tatoeba examples a term cites
    # by id. Schema 4, so an older client is gated rather than fed URL-less rows.
    # 10 ships each `sentence` record's stored token stream, so the extension
    # draws a corpus line with the cut the site read it with instead of running
    # the other engine over it. Additive and optional, so no schema gate: a
    # client that ignores `tokens` behaves exactly as it did.
    # 11 gives a sense its usage `notes` and its `xrefs` (related words and
    # antonyms), the two things on the web card the popup could not draw at all.
    # Schema 5: `validateTerm` checks a SENSE's keys exactly, so an older client
    # would abort mid-install on the new ones rather than being told, politely and
    # up front, that its dictionary needs a newer reader.
    BUILD_RECIPE_VERSION = 18
    MINIMUM_EXTENSION_VERSION = "0.2.6"

    attr_reader :output_dir, :limit, :slugs, :dictionaries, :gloss_languages

    def initialize(source:, output_dir:, limit: nil, clock: -> { Time.now.utc })
      @source = source
      @output_dir = Pathname(output_dir)
      @limit = limit&.to_i&.positive? ? limit.to_i : nil
      @clock = clock
      @slugs = source.slugs
      @dictionaries = source.dictionaries
      @gloss_languages = source.gloss_languages
    end

    def export
      output_dir.mkpath
      revision = content_revision
      artifact_name = "#{ARTIFACT_PREFIX}-#{revision}.ndjson.gz"
      temp = output_dir.join("#{artifact_name}.tmp")
      counts = Hash.new(0)

      Zlib::GzipWriter.open(temp.to_s) do |gzip|
        gzip.mtime = 0
        gzip.orig_name = artifact_name.delete_suffix(".gz")
        write_header(gzip)
        each_record do |record|
          gzip.write(JSON.generate(record))
          gzip.write("\n")
          counts[record.fetch(:type)] += 1
        end
      end

      artifact = output_dir.join(artifact_name)
      FileUtils.mv(temp, artifact)
      manifest = build_manifest(artifact, counts, revision)
      output_dir.join(MANIFEST).write(JSON.pretty_generate(manifest) + "\n")
      manifest
    ensure
      FileUtils.rm_f(temp) if defined?(temp)
    end

    def up_to_date?
      manifest = JSON.parse(output_dir.join(MANIFEST).read)
      artifact = manifest.fetch("artifact").to_s

      manifest.fetch("contentRevision") == content_revision &&
        manifest.fetch("schemaVersion") == SCHEMA_VERSION &&
        manifest.fetch("buildRecipeVersion") == BUILD_RECIPE_VERSION &&
        manifest.fetch("minimumExtensionVersion") == MINIMUM_EXTENSION_VERSION &&
        artifact == File.basename(artifact) &&
        output_dir.join(artifact).file?
    rescue Errno::ENOENT, JSON::ParserError, KeyError
      false
    end

    def revision = content_revision

    private

    def write_header(gzip)
      gzip.write(JSON.generate(
        type: "header",
        schemaVersion: SCHEMA_VERSION,
        languages: gloss_languages,
        source: personal? ? "Shirabe private dictionary" : "Shirabe open-core"
      ))
      gzip.write("\n")
    end

    def each_record(&block)
      @examples = @source.example_links(maximum: EXAMPLES_PER_TERM)
      emit_sentences(@examples.values.flatten.uniq, &block)
      dictionaries.each do |dictionary|
        written = 0
        @source.each_batch(dictionary, batch_size: BATCH_SIZE) do |entries|
          entries.each do |entry|
            record = serialize(entry)
            next unless record
            yield record
            written += 1
            break if limit && written >= limit
          end
          break if limit && written >= limit
        end
      end
    end

    def emit_sentences(ids, &block)
      @source.each_sentence(ids, batch_size: BATCH_SIZE) do |entry|
        japanese = entry.text.presence or next
        translations = entry.contents
          .select { |content| content.kind == "translation" && gloss_languages.include?(content.language) }
          .group_by(&:language)
          .transform_values { |items| items.min_by(&:position).text }
        next if translations.empty?

        pack_id = "#{entry.dictionary.slug}:#{entry.source_id}"
        sentence_pack_ids[entry.id] = pack_id
        record = { type: "sentence", id: pack_id, japanese: japanese, translations: translations }
        tokens = pack_tokens(entry.tokens, japanese)
        record[:tokens] = tokens if tokens
        block.call(record)
      end
    end

    def pack_tokens(tokens, japanese)
      packed = Array(tokens).map { |token|
        { surface: token["surface"].to_s, reading: token["reading"].presence,
          lemma: token["lemma"].presence, pos: token["pos"].presence }.compact
      }
      return nil if packed.empty? || packed.any? { |token| token[:surface].empty? }
      return nil if packed.map { |token| token[:surface] }.join != japanese

      packed
    end

    def serialize(entry)
      case entry.dictionary.kind
      when "definition", "name" then serialize_term(entry)
      when "kanji" then serialize_kanji(entry)
      end
    end

    def serialize_term(entry)
      senses = entry.senses.filter_map do |sense|
        contents_by_language = sense.contents
          .select { |content| CONTENT_KINDS.include?(content.kind) && gloss_languages.include?(content.language) }
          .group_by(&:language)
        definition_contents = contents_by_language.transform_values { |items| items.sort_by(&:position) }
        glosses = definition_contents.transform_values { |items| items.map(&:text) }
        gloss_titles = definition_contents.transform_values { |items| items.map { |content| content.title } }
        usage_contents = sense.contents
          .select { |content| content.kind == "usage" && gloss_languages.include?(content.language) }
          .group_by(&:language)
          .transform_values { |items| items.sort_by(&:position).map { |content| { text: content.text, title: content.title }.compact } }
        notes = sense.contents
          .select { |content| content.kind == "note" && gloss_languages.include?(content.language) }
          .group_by(&:language)
          .transform_values { |items| items.sort_by(&:position).map(&:text) }
        xrefs = sense.relations.sort_by(&:position).filter_map do |relation|
          text = relation.text.presence or next
          { kind: relation.kind, text: text, reading: relation.reading.presence, label: relation.label.presence }.compact
        end
        next if glosses.empty? && usage_contents.empty? && notes.empty? && xrefs.empty?

        annotations = sense.annotations.group_by(&:category).transform_values do |items|
          items.sort_by(&:position).map(&:value)
        end
        scoped_tags = sense.annotations.sort_by(&:position).map do |annotation|
          { category: annotation.category, code: annotation.value, scope: annotation.scope }
        end
        source_tags = sense.source_tags
        restrictions = sense.restrictions

        {
          label: sense.label.presence,
          depth: sense.depth,
          glosses: glosses,
          glossTitles: (gloss_titles if gloss_titles.values.flatten.any?(&:present?)),
          usages: usage_contents.presence,
          partsOfSpeech: annotations.fetch("part_of_speech", []),
          fields: annotations.fetch("field", []),
          misc: annotations.fetch("misc", []),
          dialects: annotations.fetch("dialect", []),
          scopedTags: scoped_tags.presence,
          sourceTags: source_tags.presence,
          restrictions: restrictions,
          notes: notes.presence,
          xrefs: xrefs.presence
        }.compact
      end
      return if senses.empty?

      sidecars = entry.sidecars
      pos = entry.senses.flat_map(&:annotations).select { |annotation| annotation.category == "part_of_speech" }.map(&:value)
      expression_only = pos.present? && (pos - %w[ exp unc ]).empty?
      expressions = entry.writings.sort_by(&:position).map do |writing|
        {
          text: writing.text,
          script: writing.script,
          common: writing.common,
          tags: Array(writing.tags),
          inflectionClass: (writing.inflection_class if expression_only)
        }.compact
      end
      readings = entry.readings.sort_by(&:position).map { |reading| { text: reading.text, kind: reading.kind } }
      # JMdict restricts some readings to a subset of an entry's kanji writings
      # (よいてんき reads 良い天気, never いい天気). The popup needs it to pair a
      # surface with the reading that spells it, otherwise furigana smears over
      # the whole word. Carried only when it narrows; unrestricted omits the key.
      readings += entry.writings.select { |writing| writing.script == "kana" }.map do |writing|
        { text: writing.text, kind: "kana", appliesTo: (writing.applies_to unless writing.applies_to_all?) }.compact
      end
      readings.uniq! { |reading| [ reading[:text], reading[:kind] ] }
      source_headwords = entry.source_headwords

      {
        type: "term",
        id: "#{entry.dictionary.slug}:#{entry.source_id}",
        dictionary: entry.dictionary.slug,
        headword: entry.display_headword,
        expressions: expressions,
        readings: readings,
        senses: senses,
        sourceHeadwords: source_headwords.presence,
        pitch: sidecars[:pitch],
        frequencies: sidecars[:frequencies],
        jlpt: sidecars[:jlpt],
        examples: example_ids_for(entry)
      }.compact
    end

    def sentence_pack_ids
      @sentence_pack_ids ||= {}
    end

    def example_ids_for(entry)
      Array(@examples[entry.id]).filter_map { |id| sentence_pack_ids[id] }.presence
    end

    def serialize_kanji(entry)
      char = entry.text.presence || entry.writings.first&.text
      return if char.blank?

      meanings = entry.senses.flat_map(&:contents)
        .select { |content| CONTENT_KINDS.include?(content.kind) && gloss_languages.include?(content.language) }
        .group_by(&:language)
        .transform_values { |items| items.sort_by(&:position).map(&:text) }
      metadata = entry.kanji_metadata

      {
        type: "kanji",
        id: "#{entry.dictionary.slug}:#{entry.source_id}",
        char: char,
        readings: entry.readings.group_by(&:kind).transform_values { |items| items.sort_by(&:position).map(&:text) },
        meanings: meanings,
        strokes: metadata&.strokes,
        grade: metadata&.grade,
        jlpt: metadata&.jlpt,
        frequency: metadata&.frequency_rank
      }.compact
    end

    def build_manifest(artifact, counts, revision)
      {
        schemaVersion: SCHEMA_VERSION,
        buildRecipeVersion: BUILD_RECIPE_VERSION,
        minimumExtensionVersion: MINIMUM_EXTENSION_VERSION,
        contentRevision: revision,
        builtAt: @clock.call.iso8601,
        artifact: artifact.basename.to_s,
        compression: "gzip",
        mediaType: "application/x-ndjson",
        bytes: artifact.size,
        sha256: Digest::SHA256.file(artifact).hexdigest,
        counts: { terms: counts["term"], kanji: counts["kanji"], sentences: counts["sentence"] },
        languages: gloss_languages,
        audio: audio_recipe,
        dictionaries: dictionaries.map { |dictionary| { slug: dictionary.slug, version: dictionary.version,
          languages: dictionary.languages.presence || gloss_languages } },
        modifications: modifications,
        sources: personal? ? [] : source_notices
      }
    end

    def audio_recipe = @source.audio_recipe

    def content_revision
      versions = @source.versions
      input = {
        schema: SCHEMA_VERSION,
        recipe: BUILD_RECIPE_VERSION,
        minimum: MINIMUM_EXTENSION_VERSION,
        limit: limit || "full",
        sources: versions
      }
      Digest::SHA256.hexdigest(JSON.generate(input))[0, 16]
    end

    def personal? = dictionaries.one? && dictionaries.first.visibility == "personal"

    def modifications
      return [ "Serialized from the account owner's uploaded Yomitan dictionary for local lookup." ] if personal?

      [
        "Selected and compacted fields for offline lookup.",
        "Spanish glosses are Shirabe AI-assisted and human-reviewed adaptations aligned to JMdict senses."
      ]
    end

    def source_notices
      [
        {
          name: "JMdict, JMnedict, KANJIDIC2",
          url: "https://www.edrdg.org/",
          license: "EDRDG",
          licenseUrl: "https://www.edrdg.org/edrdg/licence.html"
        },
        {
          name: "Shirabe Spanish JMdict adaptation",
          url: "https://shirabe.org/credits",
          license: "CC BY-SA 4.0",
          licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/"
        },
        {
          name: "UniDic pitch metadata",
          url: "https://clrd.ninjal.ac.jp/unidic/",
          license: "Modified BSD",
          licenseUrl: "https://clrd.ninjal.ac.jp/unidic/en/copying_en.html"
        },
        {
          name: "jiten.moe frequency lists",
          url: "https://jiten.moe/other",
          license: "CC BY-SA 4.0",
          licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/"
        }
      ]
    end
  end
end
