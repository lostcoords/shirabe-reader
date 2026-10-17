# Reader dictionary pack writer

`shirabe-reader-pack` serializes dictionary records into the compressed NDJSON and manifest consumed by Shirabe Reader. It owns the offline wire format, archive integrity metadata and redistribution notices. It has no Rails or database dependency.

The backend supplies a source with `slugs`, `dictionaries`, `gloss_languages`, `versions`, `audio_recipe`, `example_links(maximum:)`, `each_batch(dictionary, batch_size:)` and `each_sentence(ids, batch_size:)`. Iterators yield the value records in `lib/shirabe_reader_pack/records.rb`. Source versions must change whenever input content changes. The source controls database access and permission checks; the writer accepts already-authorized records.

```ruby
require "shirabe_reader_pack"
manifest = ShirabeReaderPack::Builder.new(source: source, output_dir: "packs").export
```

From this directory, run `bundle install`, `bundle exec ruby -Ilib test/builder_test.rb`, and `gem build shirabe-reader-pack.gemspec`. Run the tests against the built gem in a clean install before tagging a release as `pack-vVERSION`. Rails pins that tag and the resolved commit through Bundler.
