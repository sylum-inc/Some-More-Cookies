import { z } from 'zod';
import {
  CreateNoteRequestSchema,
  IdSchema,
  RegisterPhotoRequestSchema,
  UpdatePassportRequestSchema,
} from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/** passport domain: the player's own Campfire Passport, and public views. */
export function passportRoutes(services: ServiceRegistry): AnyRoute[] {
  const { passports } = services;
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/passport',
      auth: 'required',
      summary: 'Read your own Campfire Passport in full.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await passports.getOwn(auth.accountId) };
      },
    }),

    defineRoute({
      method: 'PATCH',
      path: '/v1/passport',
      auth: 'required',
      summary: 'Update your display name, handle, bio, avatar or settings.',
      body: UpdatePassportRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await passports.update(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/passport/photos',
      auth: 'required',
      idempotent: true,
      summary: 'Register an uploaded photo (metadata and storage key only).',
      body: RegisterPhotoRequestSchema.extend({ idempotencyKey: z.string().min(8).max(200) }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const { idempotencyKey: _key, ...photo } = ctx.body;
        return { status: 201, body: await passports.registerPhoto(auth.accountId, photo) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/passport/notes',
      auth: 'required',
      idempotent: true,
      summary: 'Scribble a note into the passport.',
      body: CreateNoteRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await passports.addNote(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'DELETE',
      path: '/v1/passport/notes/:noteId',
      auth: 'required',
      summary: 'Tear a note out.',
      params: z.object({ noteId: IdSchema }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        await passports.deleteNote(auth.accountId, ctx.params.noteId);
        return { status: 204 };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/passports/:accountId',
      auth: 'required',
      summary: "Read another player's public passport, if they allow it.",
      params: z.object({ accountId: IdSchema }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await passports.getPublicFor(auth.accountId, ctx.params.accountId) };
      },
    }),
  ];
}
