import { useCallback, useEffect, useState } from 'react';
import type { McpApp } from '@privos_ai/app-react';
import { usePolling } from '../../hooks/usePolling';
import { hasPayrollOwnerRole } from './owner-role-policy';
import { isPayrollOwnerFromContextResult } from './payroll-access-context';

type PayrollAccessApp = Pick<McpApp, 'callServerTool'>;

export async function refreshPayrollAccess(app: PayrollAccessApp): Promise<boolean> {
  try {
    // scope: basic:information — the approved room, the current user and their
    // room roles. Payroll is owner-only, so this is re-read on a poll rather
    // than trusted from the first render.
    const result = await app.callServerTool({
      name: 'privos.context.get',
      arguments: {},
    });
    return isPayrollOwnerFromContextResult(result);
  } catch {
    return false;
  }
}

export function usePayrollAccessPolling(
  app: PayrollAccessApp | null,
  userRoles: readonly string[] | null | undefined,
): boolean {
  const [canAccessPayroll, setCanAccessPayroll] = useState(() => hasPayrollOwnerRole(userRoles));

  useEffect(() => {
    setCanAccessPayroll(hasPayrollOwnerRole(userRoles));
  }, [userRoles]);

  const refreshAccess = useCallback(async () => {
    if (!app) {
      setCanAccessPayroll(false);
      return;
    }

    setCanAccessPayroll(await refreshPayrollAccess(app));
  }, [app]);

  usePolling(refreshAccess, {
    enabled: app !== null,
    interval: 1000,
    immediate: true,
    pauseOnTabHidden: false,
  });

  return canAccessPayroll;
}
