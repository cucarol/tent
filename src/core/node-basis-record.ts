import * as z from "zod/v4";
import { isNodeId } from "./id.js";
import { repositoryMaterialSchema } from "./repository-material.js";

const version = z.string().regex(/^[a-f0-9]{64}$/);
const materialBasisSchema = z.strictObject({
  identity: z.string(),
  version: version.optional(),
  fingerprintVersion: z.literal(2).optional(),
  repository: repositoryMaterialSchema.optional(),
});
export const nodeBasisRecordSchema = z.strictObject({
  materials: z.array(materialBasisSchema),
  goals: z
    .array(
      z.strictObject({
        nodeId: z.string().refine(isNodeId),
        version,
        fingerprintVersion: z.literal(2),
        materials: z.array(materialBasisSchema),
      }),
    )
    .optional(),
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
