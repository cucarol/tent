import * as z from "zod/v4";
import { isNodeId } from "./id.js";

const version = z.string().regex(/^[a-f0-9]{64}$/);
export const nodeBasisRecordSchema = z.strictObject({
  materials: z.array(
    z.strictObject({
      identity: z.string(),
      version: version.optional(),
      fingerprintVersion: z.literal(2).optional(),
    }),
  ),
  materialsRevision: version.optional(),
  goal: z
    .strictObject({
      nodeId: z.string().refine(isNodeId),
      version,
      materialsRevision: version.optional(),
      fingerprintVersion: z.literal(2).optional(),
    })
    .optional(),
});
export type NodeBasisRecord = z.infer<typeof nodeBasisRecordSchema>;
