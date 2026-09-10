import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { httpErrors } from "@fastify/sensible";
import type { AppCtx } from "../ctx.js";
import { normalizePhone } from "./auth.js";
import { pointFromJson, pointToJson } from "../geo-mappers.js";
import type { CustomerDto, GeoPoint, NotificationChannel } from "@ronmacrae/contracts";
import { Prisma, type Customer } from "@prisma/client";

type CustomerWithZone = Customer & { zone: { name: string } | null };

export function customerToDto(c: CustomerWithZone): CustomerDto {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    addressText: c.addressText,
    landmark: c.landmark,
    point: pointFromJson(c.point),
    zoneId: c.zoneId,
    zoneName: c.zone?.name ?? null,
    preferredChannel: (c.preferredChannel as NotificationChannel | null) ?? null,
    consentTracking: c.consentTracking,
    consentMarketing: c.consentMarketing,
    note: c.note,
    createdAt: c.createdAt.toISOString(),
  };
}

const PhoneSchema = z.string().min(7).max(20);

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  phone: PhoneSchema,
  email: z.string().email().optional().or(z.literal("")).nullable().default(""),
  addressText: z.string().max(200).optional().or(z.literal("")).nullable().default(""),
  landmark: z.string().max(120).optional().or(z.literal("")).nullable().default(""),
  point: z.object({ lat: z.number().gte(-90).lte(90), lng: z.number().gte(-180).lte(180) }).optional().nullable(),
  preferredChannel: z.enum(["whatsapp", "sms", "push", "in_app"]).optional().nullable(),
  consentTracking: z.boolean().default(false),
  consentMarketing: z.boolean().default(false),
  note: z.string().max(300).optional().or(z.literal("")).nullable().default(""),
});

const UpdateBody = CreateBody.partial();

const ListQuery = z.object({
  search: z.string().max(80).optional(),
  take: z.coerce.number().int().min(1).max(200).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

export class CustomersService {
  constructor(private readonly app: AppCtx) {}

  async list(search: string | undefined, take: number, skip: number): Promise<CustomerDto[]> {
    const s = search?.trim().toLowerCase();
    const rows = await this.app.prisma.customer.findMany({
      where: s
        ? {
            // NOTE: no `mode: "insensitive"` here - the schema is portable and
            // the sqlite (zero-service preview) provider has no `mode` filter.
            OR: [
              { name: { contains: s } },
              { phone: { contains: s.replace(/[^\d]/g, "") } },
              { email: { contains: s } },
              { addressText: { contains: s } },
            ],
          }
        : undefined,
      orderBy: { name: "asc" },
      take,
      skip,
      include: { zone: { select: { name: true } } },
    });
    return rows.map(customerToDto);
  }

  async get(id: string): Promise<CustomerDto | null> {
    const row = await this.app.prisma.customer.findUnique({
      where: { id },
      include: { zone: { select: { name: true } } },
    });
    return row ? customerToDto(row) : null;
  }

  async create(input: z.infer<typeof CreateBody>): Promise<CustomerDto> {
    const phone = normalizePhone(input.phone);
    const existing = await this.app.prisma.customer.findUnique({ where: { phone } });
    if (existing) throw httpErrors.createError(409, "A customer with this phone number already exists");
    const row = await this.app.prisma.customer.create({
      data: {
        name: input.name,
        phone,
        email: input.email || null,
        addressText: input.addressText || null,
        landmark: input.landmark || null,
        point: pointToJson(input.point ?? null) ?? Prisma.JsonNull,
        preferredChannel: input.preferredChannel ?? undefined,
        consentTracking: input.consentTracking,
        consentMarketing: input.consentMarketing,
        note: input.note || null,
      },
      include: { zone: { select: { name: true } } },
    });
    return customerToDto(row);
  }

  async update(id: string, input: z.infer<typeof UpdateBody>): Promise<CustomerDto> {
    const row = await this.app.prisma.customer.findUnique({ where: { id } });
    if (!row) throw httpErrors.createError(404, "Customer not found");
    const updated = await this.app.prisma.customer.update({
      where: { id },
      data: {
        name: input.name,
        phone: input.phone ? normalizePhone(input.phone) : undefined,
        email: input.email === undefined ? undefined : input.email || null,
        addressText: input.addressText === undefined ? undefined : input.addressText || null,
        landmark: input.landmark === undefined ? undefined : input.landmark || null,
        point: input.point === undefined ? undefined : (pointToJson(input.point ?? null) ?? Prisma.JsonNull),
        preferredChannel: input.preferredChannel,
        consentTracking: input.consentTracking,
        consentMarketing: input.consentMarketing,
        note: input.note === undefined ? undefined : input.note || null,
      },
      include: { zone: { select: { name: true } } },
    });
    return customerToDto(updated);
  }

  /**
   * Upsert by phone for the public delivery-request flow: the customer record
   * is the recipient. Keeps existing name/address when the form omits them.
   */
  async upsertFromRequest(input: {
    name: string;
    phone: string;
    email?: string | null;
    addressText?: string | null;
    point?: GeoPoint | null;
    consentTracking?: boolean;
  }): Promise<Customer> {
    const phone = normalizePhone(input.phone);
    const existing = await this.app.prisma.customer.findUnique({ where: { phone } });
    const point =
      (input.point ? pointToJson(input.point) : (existing?.point as Prisma.InputJsonValue | null | undefined) ?? null) ??
      Prisma.JsonNull;
    const data = {
      name: input.name || existing?.name || "Customer",
      email: input.email ?? existing?.email ?? null,
      addressText: input.addressText ?? existing?.addressText ?? null,
      point,
      consentTracking: input.consentTracking ?? existing?.consentTracking ?? false,
    };
    if (existing) {
      return this.app.prisma.customer.update({ where: { phone }, data });
    }
    return this.app.prisma.customer.create({ data: { ...data, phone } });
  }
}

export async function customerRoutes(app: FastifyInstance, ctx: AppCtx): Promise<void> {
  const svc = new CustomersService(ctx);

  app.get("/api/customers", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    const q = ListQuery.parse(req.query);
    return { customers: await svc.list(q.search, q.take, q.skip) };
  });

  app.get("/api/customers/search", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    const q = z.object({ q: z.string().max(80).optional(), take: z.coerce.number().int().min(1).max(20).default(10) }).parse(req.query);
    return { customers: await svc.list(q.q, q.take, 0) };
  });

  app.post("/api/customers", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = CreateBody.parse(req.body);
    const customer = await svc.create(body);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "customer.create", "customer", customer.id, { name: customer.name });
    return { customer };
  });

  app.get<{ Params: { id: string } }>("/api/customers/:id", { preHandler: ctx.requireStaff("admin", "dispatcher", "accountant", "viewer") }, async (req) => {
    const customer = await svc.get(req.params.id);
    if (!customer) throw httpErrors.createError(404, "Customer not found");
    return { customer };
  });

  app.patch<{ Params: { id: string } }>("/api/customers/:id", { preHandler: ctx.requireStaff("admin", "dispatcher") }, async (req) => {
    const body = UpdateBody.parse(req.body);
    const customer = await svc.update(req.params.id, body);
    await ctx.audit.record({ id: req.user!.sub, role: req.user!.role }, "customer.update", "customer", customer.id);
    return { customer };
  });
}
