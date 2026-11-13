/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'xenra-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart xenra-superagent. DSH's settings service stops
  // serving this entry while xenra-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('xenra-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  // Stopping releases the state directory lock but deliberately leaves the directory on disk: it holds the database of a
  // working installation, and removing it on every restart would destroy it. Removing it is a separate, explicit act, and
  // this is where it is offered — the panel's "remove this installation" action calls `removeState`, so uninstalling the
  // plugin does not leave a `worker-gitconfig` behind for a machine to find later.
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'xenra-superagent ready; the Xenra-SuperAgent sidebar entry opens the management panel' : `xenra-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
