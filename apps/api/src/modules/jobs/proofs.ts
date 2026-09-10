import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../../ctx.js";
import { isStaff } from "../guards.js";
import type { ProofDto, ProofKind } from "@ronmacrae/contracts";
import { PROOF_KINDS } from "@ronmacrae/contracts";
import { pointFromJson, pointToJson } from "../../geo-mappers.js";
import { randomToken } from "../../lib/ids.js";
import { proofToDto } from "./dto.js";

/** api package root (apps/api) */
const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const UPLOAD_ROOT = join(apiRoot, "data", "uploads", "proofs");

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Resolve a `/api/proofs/:key` segment to a safe on-disk location. */
function proofPath(key: string): { key: string; path: string; mime: string } | null {
  const dot = key.lastIndexOf(".");
  if (dot <= 0 || dot === key.length - 1) return null;
  const token = key.slice(0, dot);
  const ext = key.slice(dot);
  if (!/^[A-Za-z0-9]+$/.test(token) || !Object.keys(MIME_BY_EXT).includes(ext)) return null;
  return { key, path: join(UPLOAD_ROOT, key), mime: MIME_BY_EXT[ext]! };
}

const CreateProofBody = z.object({
  kind: z.enum(PROOF_KINDS),
  point: z
    .object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) })
    .optional()
    .nullable(),
});

/** Multipart form fields arrive as strings; parse the optional point. */
function parsePointField(raw: string | undefined): { lat: number; lng: number } | null {
  if (!raw) return null;
  try {
    return CreateProofBody.parse({ point: JSON.parse(raw) }).point ?? null;
  } catch {
    return null;
  }
}

/** Extract a scalar form field value from a multipart field bag. */
function fieldString(fields: Record<string, unknown>, name: string): string | undefined {
  const f = fields[name];
  if (f === undefined) return undefined;
  const single = Array.isArray(f) ? f[0] : f;
  if (single && typeof single === "object" && "type" in single && single.type === "field") {
    const value = (single as { value: unknown }).value;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * Proof-of-delivery uploads.
 * POST /api/jobs/:jobId/proofs  - multipart (file + kind [+ point])
 * GET  /api/proofs/:key         - staff or the job's rider
 * Files land in data/uploads/proofs/ (zero-service, like the dev sqlite file).
 */
export async function proofRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.post<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/proofs",
    { preHandler: ctx.requireAuth },
    async (req) => {
      const job = await ctx.prisma.job.findUnique({ where: { id: req.params.jobId } });
      if (!job) throw httpErrors.createError(404, "Job not found");
      const user = req.user!;
      if (!isStaff(user.role) && job.riderId !== user.riderId) {
        throw httpErrors.createError(403, "You can only add proofs for your own jobs");
      }

      const file = await req.file();
      if (!file) throw httpErrors.createError(400, "Missing file part");
      const fields = file.fields ?? {};
      const kindRaw = fieldString(fields, "kind");
      if (!kindRaw) throw httpErrors.createError(400, "Missing kind field (pickup_photo, delivery_photo, receipt_photo, signature, package_photo)");
      const body = CreateProofBody.parse({ kind: kindRaw, point: parsePointField(fieldString(fields, "point")) });

      const chunks: Buffer[] = [];
      for await (const chunk of file.file) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);

      const ext = file.mimetype ? EXT_BY_MIME[file.mimetype] : undefined;
      if (!ext) throw httpErrors.createError(415, "Unsupported file type (jpg, png, webp or pdf)");
      const mime = file.mimetype;

      const key = `${randomToken(18)}.${ext}`;
      const absPath = join(UPLOAD_ROOT, key);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, buffer);
      const hash = createHash("sha256").update(buffer).digest("hex");

      const row = await ctx.prisma.proof.create({
        data: {
          jobId: job.id,
          kind: body.kind as ProofKind,
          filename: key,
          url: `/api/proofs/${key}`,
          hash,
          size: buffer.length,
          point: pointToJson(body.point) ?? undefined,
        },
      });
      return { proof: proofToDto(row) satisfies ProofDto };
    },
  );

  app.get<{ Params: { key: string } }>("/api/proofs/:key", { preHandler: ctx.requireAuth }, async (req, reply) => {
    const stored = proofPath(req.params.key);
    if (!stored) throw httpErrors.createError(400, "Invalid proof key");
    const row = await ctx.prisma.proof.findFirst({ where: { filename: stored.key } });
    if (!row) throw httpErrors.createError(404, "Proof not found");
    const user = req.user!;
    if (!isStaff(user.role)) {
      const job = await ctx.prisma.job.findUnique({ where: { id: row.jobId }, select: { riderId: true } });
      if (job?.riderId !== user.riderId) throw httpErrors.createError(403, "Not your proof");
    }
    if (!existsSync(stored.path)) throw httpErrors.createError(404, "Proof file missing on disk");
    reply.header("content-type", stored.mime);
    reply.header("content-disposition", `attachment; filename="${stored.key}"`);
    return reply.send(createReadStream(stored.path));
  });
}
