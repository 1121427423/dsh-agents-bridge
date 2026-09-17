/**
 * The plugin's settings namespace, in a module with NO imports.
 *
 * It lives apart from `src/settings.ts` for one reason: the client half needs the
 * same string, and `src/settings.ts` imports a Node-side schema library. Importing
 * that from the browser bundle would either pull schemastery in or silently break
 * the build's external list; a bare string cannot do either. The namespace is also
 * the client card's slot key (`settings.plugin.item`), so the two halves being
 * unable to disagree is a property worth enforcing structurally.
 *
 * @module dsh-agents-bridge/namespace
 */

/**
 * Settings namespace; lowercase and hyphenated, per the settings service's grammar.
 *
 * It equals the PACKAGE NAME on purpose, not the cordis plugin name
 * (`agents-bridge`, which only appears inside the Node half). The package name is
 * the identifier a user actually sees: it is the patch row id, the client
 * ModuleLoader id, the `registrant` on every slot — and now the section key in
 * `settings.yaml`, next to other plugins' entries. One plugin, one id, four
 * places; `tests/integration/client-bundle.test.ts` asserts the settings key and
 * the package name are the same string, so they cannot drift apart.
 */
export const SETTINGS_NAMESPACE = 'dsh-agents-bridge'
