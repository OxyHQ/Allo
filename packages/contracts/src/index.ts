import { z } from 'zod';
export const TEAM_CAPABILITY_HEADER = 'x-allo-team-capability';
export const teamOperationIdSchema = z.string().min(1).max(200);
export const teamSnapshotSchema = z.strictObject({
  conversationId: z.string(),
  sourceReference: z.string(),
  ownerAccountId: z.string(),
  memberAccountIds: z.array(z.string()),
  epoch: z.number().int().nonnegative(),
  operationId: teamOperationIdSchema,
  frozen: z.boolean(),
});
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>;
export const teamOperationRequestSchema = z.strictObject({ operationId: teamOperationIdSchema });
