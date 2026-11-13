/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { removeState } from './infra/environment.ts'
import { watchForRemoval } from './infra/profile.ts'

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
  // DSH emits its management operations while the plugin is still running. Watching them is the only way to tell a plain
  // uninstall from a disable or an update, all of which stop the plugin; doing that wrong would delete a working
  // installation's data. This subscribes to events DSH already emits — nothing in DSH is changed.
  const isUninstall = watchForRemoval(ctx, 'xenra-superagent')
  /**
   * Stopping releases the state directory lock but leaves the directory on disk: it holds the database of a working
   * installation, and a restart must not destroy it.
   *
   * On a real uninstall the watcher above confirms it, and the files this plugin wrote are removed so no stray
   * `worker-gitconfig` is left for a later run of git to pick up. This is the only case where a person cannot clean up
   * afterwards: the panel that would offer it disappears with the plugin.
   */
  ctx.effect(() => async () => {
    await runtime.stop()
    if (!isUninstall()) return
    const { removed, kept } = await removeState(machine.stateDir).catch(() => ({ removed: [], kept: [] }))
    ctx.logger.info('xenra-superagent was uninstalled; deleted %s, kept %s', removed.join(', ') || 'nothing',
      kept.join(', ') || 'nothing')
  })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'xenra-superagent ready; the Xenra-SuperAgent sidebar entry opens the management panel' : `xenra-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
