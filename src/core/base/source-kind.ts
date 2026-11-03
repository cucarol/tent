/** Path-only source classes, shared by the module map and the tool hook, which loads no extractor. */
export const isCFamilySource = (file: string) =>
  /\.(?:c|cc|cpp|cxx|C|h|hh|hpp|hxx|inc|inl|ipp|tpp)$/.test(file);
export const isTestSource = (file: string) =>
  /(^|\/)(tests?|__tests__|spec|testdata|fixtures)\/|(^|\/)test_[^/]+\.py$|[._-](test|spec)\.[^/]+$|_test\.go$/.test(
    file,
  );
export const isCodeSource = (file: string) =>
  /\.(go|[cm]?[jt]sx?|py|rs|java|kt|swift|rb|php|cs|vue|svelte)$/.test(file) ||
  isCFamilySource(file);
export const isGeneratedSource = (file: string) =>
  /(^|\/)(gen|generated|__generated__)\/|\.pb\.go$|_pb\.ts$|\.pb\.ts$|\.g\.dart$/.test(file);
export const isVendorSource = (file: string) =>
  /(^|\/)(vendor|node_modules|third_party|third-party)\//.test(file);
/** Binary assets stay in their directory's part without counting toward its reading size. */
export const isBinaryAsset = (file: string) =>
  /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|tiff?|psd|svg|mp[34]|m4[av]|mov|mkv|avi|webm|wav|flac|ogg|aac|aiff?|woff2?|ttf|otf|eot|pdf|docx?|xlsx?|pptx?|zip|gz|bz2|xz|7z|rar|exe|dll|so|dylib|wasm|class|jar|sqlite3?|db|bin)$/i.test(
    file,
  );
/** Agent-readable project text, including prose, data and configuration. */
export const isPartTextSource = (file: string) =>
  !isBinaryAsset(file) &&
  !isTestSource(file) &&
  !isGeneratedSource(file) &&
  !isVendorSource(file) &&
  !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$/.test(file);
/** Hand-written product code: the files a module map must place. */
export const isModuleProductionSource = (file: string) =>
  isCodeSource(file) && !isTestSource(file) && !isGeneratedSource(file) && !isVendorSource(file);
