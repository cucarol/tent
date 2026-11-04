import { AsyncLocalStorage } from "node:async_hooks";
import { withFrontmatterCache } from "../core/base/frontmatter.js";
import { withMarkdownSyntaxCache } from "../core/base/markdown-syntax.js";
import { withSemanticContentCache } from "../core/base/semantic-content-cache.js";
import { withFileReadScope } from "./file-state-cache.js";
import { withPersistedCache } from "./persisted-cache.js";

const activeRoot = new AsyncLocalStorage<string>();

/** Share exact header/syntax parses and scoped observations, never a complete result. */
export async function withDocumentHeaderCache<T>(systemRoot: string, action: () => Promise<T>) {
  return withFileReadScope(() => {
    if (activeRoot.getStore() === systemRoot) return action();
    // Bump a version when its YAML grammar, Markdown extraction or semantic content rules change.
    return activeRoot.run(systemRoot, () =>
      withPersistedCache(systemRoot, "markdown-syntax.bin", 2, withMarkdownSyntaxCache, () =>
        withPersistedCache(systemRoot, "semantic-content.bin", 1, withSemanticContentCache, () =>
          withPersistedCache(systemRoot, "document-headers.bin", 2, withFrontmatterCache, action),
        ),
      ),
    );
  });
}
