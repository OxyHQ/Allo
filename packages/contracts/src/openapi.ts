import { z } from 'zod';
import { teamOperationRequestSchema, teamSnapshotSchema } from './index';
const routes = [
  { path: '/team-access/snapshot', operationId: 'readTeamSnapshot', write: false },
  { path: '/teams/prepare', operationId: 'prepareTeamOperation', write: true },
  { path: '/teams/finish', operationId: 'finishTeamOperation', write: true },
] as const;
export function generateTeamOpenApi() {
  return {
    openapi: '3.1.0',
    info: { title: 'Allo managed team access', version: '0.2.0' },
    servers: [{ url: 'https://api.allo.you/v1' }],
    paths: Object.fromEntries(
      routes.map((route) => [
        route.path,
        {
          post: {
            operationId: route.operationId,
            description: route.write
              ? 'Creator-signed operation; verifies the Homiio source operation through its owning SDK. Membership remains frozen until source finalization.'
              : 'Oxy service token (transport identity, minted for oxy-service:<Allo application id> by @oxy.so/allo-sdk/server) plus the resource-scoped header capability. Reveals only membership and operation state, never messages or housing content. No-store.',
            security: [
              route.write
                ? {
                    TeamCapability: [],
                    OxySession: [],
                    InstanceSignature: [],
                    HomiioOperationCapability: [],
                  }
                : { OxyServiceToken: [], TeamCapability: [] },
            ],
            ...(route.write
              ? {
                  requestBody: {
                    required: true,
                    content: {
                      'application/json': {
                        schema: { $ref: '#/components/schemas/TeamOperationRequest' },
                      },
                    },
                  },
                  parameters: [
                    {
                      name: 'x-allo-instance',
                      in: 'header',
                      required: true,
                      schema: { type: 'string' },
                    },
                    {
                      name: 'x-allo-timestamp',
                      in: 'header',
                      required: true,
                      schema: { type: 'string' },
                    },
                  ],
                }
              : {}),
            responses: {
              '200': {
                description: 'Current coherent team snapshot',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/TeamSnapshot' } },
                },
              },
              '404': { description: 'No accessible team' },
              ...(route.write
                ? {
                    '403': { description: 'Creator authorization failed' },
                    '409': { description: 'Another operation must complete first' },
                    '503': { description: 'Source unavailable; group remains frozen' },
                  }
                : {
                    '401': { description: 'Missing, invalid or inactive Oxy service token' },
                    '403': { description: 'The bearer is not a service token' },
                    '503': { description: 'Oxy cannot confirm the service identity' },
                  }),
            },
          },
        },
      ]),
    ),
    components: {
      schemas: {
        TeamSnapshot: z.toJSONSchema(teamSnapshotSchema),
        TeamOperationRequest: z.toJSONSchema(teamOperationRequestSchema),
      },
      securitySchemes: {
        TeamCapability: { type: 'apiKey', in: 'header', name: 'x-allo-team-capability' },
        OxySession: { type: 'http', scheme: 'bearer' },
        OxyServiceToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        InstanceSignature: { type: 'apiKey', in: 'header', name: 'x-allo-signature' },
        HomiioOperationCapability: {
          type: 'apiKey',
          in: 'header',
          name: 'x-homiio-team-operation',
        },
      },
    },
  };
}
