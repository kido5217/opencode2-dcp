import type { DcpConfig } from "../config.ts";
import type { SessionState } from "./types.ts";
import {
  type HostPermissionSnapshot,
  resolveEffectiveCompressPermission,
} from "./host-permissions.ts";

/**
 * v2 port of v1 `lib/compress-permission.ts`.
 *
 * v1 derived the active agent from the last user message's `info.agent`;
 * the v2 `context` hook payload carries the agent id directly.
 */

export const compressPermission = (
  state: SessionState,
  config: DcpConfig,
): "ask" | "allow" | "deny" => {
  return state.compressPermission ?? config.compress.permission;
};

export const syncCompressPermissionState = (
  state: SessionState,
  config: DcpConfig,
  hostPermissions: HostPermissionSnapshot,
  agentId?: string,
): void => {
  state.compressPermission = resolveEffectiveCompressPermission(
    config.compress.permission,
    hostPermissions,
    agentId,
  );
};
