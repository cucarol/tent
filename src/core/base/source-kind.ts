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
/** Hand-written product code: the files a module map must place. */
export const isModuleProductionSource = (file: string) =>
  isCodeSource(file) && !isTestSource(file) && !isGeneratedSource(file) && !isVendorSource(file);
