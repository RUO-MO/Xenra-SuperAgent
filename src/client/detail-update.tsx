/**
 * "Check for updates" on the plugin manager DETAIL page.
 *
 * The detail slot renders outside this plugin's own main panel, so there is no PanelProvider context there. Rather than keep
 * a second update implementation — which drifted from the panel's confirmation, diagnostics and typed API — this registers
 * the very same UpdateStatus inside a small PanelProvider of its own. One component, one safety flow, one set of messages;
 * the detail page only decides when to draw it (on this bundle's own page).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PluginDetailProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { PanelProvider } from './provider.tsx'
import { UpdateStatus } from './update-status.tsx'
import type { T } from './text.ts'

const ENTRY = 'xenra-superagent'

/** Registers the detail-page section for this bundle and disposes it with the client fiber. */
export function registerDetailUpdate(ctx: Context): void {
  const t = ctx.locale.bind('xenraSuperagent') as unknown as T
  ctx.effect(() => ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: 'xenra-superagent-update',
    order: 100,
  }, ((props: PluginDetailProps) => {
    // Draw only on this bundle's own detail page; rows and official plugins have nothing to update here.
    if (props.subject.kind !== 'bundle' || props.subject.pkg.name !== ENTRY) return null
    // PanelProvider supplies the typed `call`, translations, the stylesheet and the toast/confirmation primitives that
    // UpdateStatus needs, independent of whether the sidebar panel happens to be mounted.
    return <PanelProvider t={t}><UpdateStatus /></PanelProvider>
  }) as never)), 'xenra-superagent: detail update section')
}
