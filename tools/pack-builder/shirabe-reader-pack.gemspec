Gem::Specification.new do |spec|
  spec.name = "shirabe-reader-pack"
  spec.version = "0.1.0"
  spec.summary = "Portable serialization and archive generation for Shirabe Reader dictionaries"
  spec.authors = ["David Fons"]
  spec.license = "GPL-3.0-only"
  spec.homepage = "https://github.com/lostcoords/shirabe-reader"
  spec.required_ruby_version = ">= 3.2"
  spec.files = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]
  spec.add_dependency "activesupport", "~> 8.0"
end
