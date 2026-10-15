import * as z from "zod/v4";

const timestamp = z.iso.datetime({ offset: true });
const address = z
  .string()
  .min(1)
  .refine((value) => {
    if (/[\u0000-\u001f]/.test(value)) return false;
    if (value.startsWith("file:")) {
      try {
        const url = new URL(value);
        return (
          url.protocol === "file:" &&
          (!url.hostname || url.hostname === "localhost") &&
          !url.pathname.startsWith("//") &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }
    return (
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[a-z][a-z\d+.-]*:/i.test(value) &&
      !value.split("/").some((part) => part === ".." || part === "." || !part)
    );
  });
export const sessionFileObservationSchema = z.strictObject({
  kind: z.enum(["provided", "read", "written"]),
  address,
  eventAt: timestamp.optional(),
});
export type SessionFileObservation = z.infer<typeof sessionFileObservationSchema>;
export const sessionSignalSchema = z.enum(["possible-requirement", "possible-decision"]);
export type SessionSignal = z.infer<typeof sessionSignalSchema>;
export type SessionObservationActivity = {
  observations: SessionFileObservation[];
  signals: SessionSignal[];
  uncertain: boolean;
  cancelled?: true;
  nodeOrCardChanged?: true;
};
export type SessionObservationEvent = {
  turnId: string;
  files: SessionFileObservation[];
  signals: SessionSignal[];
  uncertain: boolean;
  cancelled?: true;
  nodeOrCardChanged?: true;
};
