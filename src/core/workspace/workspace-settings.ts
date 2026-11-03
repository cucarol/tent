import * as z from "zod/v4";
import { type FsAdapter } from "../store/adapter.js";
import { WORKSPACE_SETTINGS_PATH } from "../base/paths.js";

const settingsSchema = z.looseObject({
  // The identity travels with a copied graph; it does not claim exclusive ownership.
  workspaceId: z.string().trim().min(1).optional(),
});

export async function readWorkspaceSettings(fs: FsAdapter) {
  return settingsSchema.parse(
    (await fs.exists(WORKSPACE_SETTINGS_PATH))
      ? JSON.parse(await fs.readFile(WORKSPACE_SETTINGS_PATH))
      : {},
  );
}
