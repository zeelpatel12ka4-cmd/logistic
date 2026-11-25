import { z } from 'zod';

export const Bytes32Schema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid 32-byte hex string');

export const EvmAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid EVM address');

export const QrPayloadSchema = z.object({
  v: z.literal(1),
  chainId: z.number().int().positive(),
  contractAddress: EvmAddressSchema,
  batchId: Bytes32Schema,
  productId: Bytes32Schema,
  serialNumber: z.string().min(1).max(128),
  metadataHash: Bytes32Schema,
  claimSecretHash: Bytes32Schema,
  claimSecret: z.string().min(1).max(128).optional(),
  merkleProof: z.array(Bytes32Schema),
});

export type QrPayload = z.infer<typeof QrPayloadSchema>;

export const CreateBatchRequestSchema = z.object({
  batchCode: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'Batch code must be alphanumeric with - or _'),
  productName: z.string().min(2).max(160),
  sku: z.string().min(2).max(64),
  category: z.string().min(2).max(64),
  manufacturerName: z.string().min(2).max(128),
  description: z.string().min(2).max(2000),
  serialPrefix: z
    .string()
    .min(2)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/),
  unitCount: z.number().int().min(1).max(100_000),
  specifications: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  includeClaimSecrets: z.boolean().default(true),
});

export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;

export const ShipmentNoteSchema = z.object({
  txHash: Bytes32Schema,
  productId: Bytes32Schema.optional(),
  batchId: Bytes32Schema.optional(),
  carrierName: z.string().min(1).max(128),
  trackingNumber: z.string().min(1).max(128),
  originLocation: z.string().min(1).max(128),
  destinationLocation: z.string().min(1).max(128),
  temperatureRange: z.string().max(64).optional(),
  notes: z.string().max(1000).optional(),
});

export type ShipmentNoteInput = z.infer<typeof ShipmentNoteSchema>;

export const SiweVerifySchema = z.object({
  message: z.string().min(20),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});

export const ScanReportSchema = z.object({
  productId: Bytes32Schema,
  scannerRegion: z.string().min(1).max(128).default('Unknown'),
  clientFingerprint: z.string().max(128).optional(),
});
