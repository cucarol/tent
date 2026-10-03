import * as z from "zod/v4";
import { isNodeId } from "./id.js";

export const readerBatchSchema = z
  .strictObject({
    nodeIds: z.array(z.string().refine(isNodeId, "Invalid Node ID")).min(1),
    view: z.enum(["body", "raw"]).default("body"),
    capture: z.boolean().optional(),
  })
  .refine((p) => new Set(p.nodeIds).size === p.nodeIds.length, "Supply each Node only once");
export type ReaderBatch = z.input<typeof readerBatchSchema>;
