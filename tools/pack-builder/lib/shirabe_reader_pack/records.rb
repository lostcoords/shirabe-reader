module ShirabeReaderPack
  Dictionary = Data.define(:id, :slug, :kind, :version, :languages, :visibility)
  Content = Data.define(:kind, :language, :text, :position, :title)
  Annotation = Data.define(:category, :value, :scope, :position)
  Relation = Data.define(:position, :kind, :text, :reading, :label)
  Sense = Data.define(:label, :depth, :contents, :annotations, :relations, :restrictions, :source_tags)
  Reading = Data.define(:text, :kind, :position)
  Writing = Data.define(:text, :script, :common, :tags, :position, :applies_to, :inflection_class) do
    def applies_to_all? = applies_to == [ "*" ]
  end
  Kanji = Data.define(:strokes, :grade, :jlpt, :frequency_rank)
  Entry = Data.define(:id, :dictionary, :source_id, :text, :display_headword,
    :writings, :readings, :senses, :source_headwords, :kanji_metadata, :sidecars)
  Sentence = Data.define(:id, :dictionary, :source_id, :text, :contents, :tokens)
end
