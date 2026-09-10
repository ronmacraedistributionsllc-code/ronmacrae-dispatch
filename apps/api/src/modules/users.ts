import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { hashPassword } from "../lib/password.js";
import { toUserDto } from "./auth.js";
import { normalizePhone } from "./auth.js";
import type { Role } from "@ronmacrae/contracts";

const RoleEnum = z.enum(["admin", "dispatcher", "accountant", "viewer", "rider"]);

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional().or(z.literal("")).default(""),
  phone: z.string().min(7).max(20).optional().or(z.literal("")).default(""),
  password: z.string().min(8).max(128),
  role: RoleEnum,
});

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional().or(z.literal("")).nullable(),
  phone: z.string().min(7).max(20).optional().or(z.literal("")).nullable(),
  role: RoleEnum.optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
});

export async function userRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  app.get("/api/users", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async () => {
    const users = await ctx.prisma.user.findMany({ orderBy: { name: "asc" }, include: { rider: { select: { id: true } } } });
    return { users: users.map(toUserDto) };
  });

  app.post("/api/users", { preHandler: ctx.requireStaff("admin") }, async (req) => {
    const body = CreateBody.parse(req.body);
    if (!body.email && !body.phone) throw httpErrors.createError(400, "Email or phone required");
    const user = await ctx.prisma.user.create({
      data: {
        name: body.name,
        email: body.email || null,
        phone: body.phone ? normalizePhone(body.phone) : null,
        passwordHash: hashPassword(body.password),
        role: body.role,
      },
    });
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "user.create", "user", user.id, { name: body.name, role: body.role });
    return { user: toUserDto(user) };
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", { preHandler: ctx.requireStaff("admin") }, async (req) => {
    const body = UpdateBody.parse(req.body);
    const target = await ctx.prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) throw httpErrors.createError(404, "User not found");
    const user = await ctx.prisma.user.update({
      where: { id: target.id },
      data: {
        name: body.name,
        email: body.email === null ? null : body.email || null,
        phone: body.phone === null ? null : body.phone ? normalizePhone(body.phone) : null,
        role: body.role as Role | undefined,
        active: body.active,
        passwordHash: body.password ? hashPassword(body.password) : undefined,
      },
    });
    if (body.active === false && target.role === "rider") {
      await ctx.prisma.session.deleteMany({ where: { userId: target.id } });
    }
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "user.update", "user", target.id, { changes: Object.keys(body) });
    return { user: toUserDto(user) };
  });
}
