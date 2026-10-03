import { z } from "zod";
import { type FsAdapter } from "./adapter.js";
import { WORKSPACE_SETTINGS_PATH } from "./paths.js";

const settingsSchema = z.looseObject({
  workspaceId: z.string().trim().min(1).optional(),
});

export async function readWorkspaceSettings(fs: FsAdapter) {
  return settingsSchema.parse(
    (await fs.exists(WORKSPACE_SETTINGS_PATH))
      ? JSON.parse(await fs.readFile(WORKSPACE_SETTINGS_PATH))
      : {},
  );
}
