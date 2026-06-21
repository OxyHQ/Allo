/**
 * Shared types for Allo.
 *
 * TypeScript contracts shared between the Allo frontend and backend.
 * These model the WIRE / transport layer — the HTTP response envelope
 * and the serialized message / conversation / device DTOs — NOT the
 * frontend's presentation-shaped store types.
 */

// API transport envelope + pagination
export * from "./api";

// Message DTOs (encrypted + legacy plaintext)
export * from "./message";

// Conversation + enriched participant DTOs
export * from "./conversation";

// Device / Signal Protocol key DTOs
export * from "./device";
