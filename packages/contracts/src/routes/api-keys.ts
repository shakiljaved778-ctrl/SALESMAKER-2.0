import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { Uuid } from '../primitives.js';

const KeyName = z.string().trim().min(1).max(80);

export const ApiKeyDto = z
  .object({
    id: Uuid,
    name: z.string(),
    environment: z.enum(['LIVE', 'TEST']),
    /** `sm_live_…abcd`: the prefix and the last four characters, to tell keys apart. */
    preview: z.string(),
    runAsUser: z.object({ id: Uuid, name: z.string() }),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    /** The key this one replaced, when it came from a rotation. */
    rotatedFromId: Uuid.nullable(),
    status: z.enum(['active', 'expired', 'revoked']),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ApiKey' });

/** Returned once, at creation or rotation: the secret is never shown again. */
export const IssuedApiKeyDto = z
  .object({ key: ApiKeyDto, secret: z.string() })
  .meta({ id: 'IssuedApiKey' });

export const CreateApiKeyRequest = z
  .object({
    name: KeyName,
    environment: z.enum(['LIVE', 'TEST']).default('LIVE'),
    /** The user the key acts as; it needs the "API enabled" permission. */
    runAsUserId: Uuid,
    /** Optional expiry, in the future. */
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

export const RotateApiKeyRequest = z
  .object({
    /**
     * How long the old key keeps working, so integrations can switch over (0 = revoke now, at
     * most 7 days).
     */
    graceMinutes: z.number().int().min(0).max(10_080).default(0),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();

export const ApiKeyIdParam = z.object({ id: Uuid });

const forbidden = { 403: { description: 'The caller lacks the required system permission' } };
const route = (spec: Omit<Parameters<typeof defineRoute>[0], 'tags' | 'auth' | 'visibility'>) =>
  defineRoute({ ...spec, tags: ['setup'], auth: 'session', visibility: 'internal' });

/** Setup → API keys (§6, §10.1). Reading needs view_setup, changes manage_users. */
export const apiKeyRoutes = {
  listApiKeys: route({
    method: 'get',
    path: '/v1/setup/api-keys',
    operationId: 'listApiKeys',
    summary: 'The organisation’s API keys (never their secrets)',
    responses: {
      200: { description: 'API keys', body: z.object({ items: z.array(ApiKeyDto) }) },
      ...forbidden,
    },
  }),
  createApiKey: route({
    method: 'post',
    path: '/v1/setup/api-keys',
    operationId: 'createApiKey',
    summary: 'Create an API key; its secret is returned once',
    request: { body: CreateApiKeyRequest },
    responses: {
      201: { description: 'The key and its secret', body: IssuedApiKeyDto },
      ...forbidden,
    },
  }),
  rotateApiKey: route({
    method: 'post',
    path: '/v1/setup/api-keys/{id}/rotate',
    operationId: 'rotateApiKey',
    summary: 'Replace a key with a new secret; the old one stops working after the grace period',
    request: { params: ApiKeyIdParam, body: RotateApiKeyRequest },
    responses: {
      201: { description: 'The new key and its secret', body: IssuedApiKeyDto },
      409: { description: 'The key is revoked or expired' },
      ...forbidden,
    },
  }),
  revokeApiKey: route({
    method: 'delete',
    path: '/v1/setup/api-keys/{id}',
    operationId: 'revokeApiKey',
    summary: 'Revoke a key at once',
    request: { params: ApiKeyIdParam },
    responses: { 204: { description: 'Revoked' }, ...forbidden },
  }),
};
