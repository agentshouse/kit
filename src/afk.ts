import type { CreateElicitationResponse, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

export const PLAN_APPROVED = { outcome: 'approved' };

export const QUESTION_DECLINED: CreateElicitationResponse = { action: 'decline' };

export function permissionAllowed({ options }: RequestPermissionRequest): RequestPermissionResponse {
  const option = options.find(({ kind }) => kind === 'allow_once') ?? options.find(({ kind }) => kind === 'allow_always');
  return { outcome: { outcome: 'selected', optionId: option!.optionId } };
}
