import type { Application } from "express";
import type { Namespace, Server, Socket } from "socket.io";
import type { OxyAuthRequest } from "@oxyhq/core/server";

export interface AuthenticatedSocketUser {
  id: string;
  userId?: string;
  sessionId?: string | null;
}

export interface AuthenticatedSocketData {
  userId?: string;
  sessionId?: string | null;
  token?: string;
}

export interface AuthenticatedSocket extends Socket {
  user?: AuthenticatedSocketUser;
  data: Socket["data"] & AuthenticatedSocketData;
}

export interface AlloRealtimeServer {
  io: Server;
  messagingNamespace: Namespace;
}

export interface AlloAppLocals {
  realtime?: AlloRealtimeServer;
}

export interface AlloApplication extends Application {
  locals: Application["locals"] & AlloAppLocals;
}

export interface AlloAuthRequest extends OxyAuthRequest {
  app: AlloApplication;
}
