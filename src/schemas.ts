import { z } from "zod";

export const eventPropertiesSchema = z
  .record(z.unknown())
  .refine((properties) => JSON.stringify(properties).length <= 32_000, {
    message: "Event properties exceed 32KB",
  });

export const trackInputSchema = z.object({
  eventName: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[\w \-:.]+$/, "Event names may only contain letters, digits, spaces, - _ : ."),
  properties: eventPropertiesSchema.default({}),
});

export const identifyInputSchema = z.object({
  userId: z.string().min(1).max(128),
  traits: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default({}),
});

export const pushTokenSchema = z.object({
  platform: z.enum(["WEB", "ANDROID", "IOS", "OTHER"]),
  pushToken: z.string().min(8).max(512),
  deviceInfo: z.record(z.unknown()).default({}),
});

export type TrackInput = z.infer<typeof trackInputSchema>;
export type IdentifyInput = z.infer<typeof identifyInputSchema>;
export type PushTokenInput = z.infer<typeof pushTokenSchema>;

export function validate<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { issues: Array<{ message: string; path: (string | number)[] }> } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    const issue = result.error?.issues[0];
    const path = issue?.path?.join(".") ?? "";
    throw Object.assign(new Error(`Validation failed${path ? ` at ${path}` : ""}: ${issue?.message ?? "unknown"}`), {
      code: "VALIDATION_ERROR",
      details: result.error?.issues,
    });
  }
  return result.data;
}
