import { OxyServices } from '@oxy.so/core';
import { OXY_BASE_URL } from '@/config';

/** Shared by the one OxyProvider and linked Allo clients; the provider owns auth. */
export const oxyClient = new OxyServices({ baseURL: OXY_BASE_URL });
