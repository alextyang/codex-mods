// qa.migrate's migration 1 -> 2 (docs/design/systems.md E5): it runs on a staged copy of the data, inside the copy's update.
export async function migrate({ from, to, storage }) { await storage.set('schema', to); await storage.set('migratedFrom', from); }
