/**
 * Connexion hors ligne sur un appareil. Règles (docs/specs, « Appareils et appairage ») :
 * - un appareil appartient à un seul utilisateur : seul son propriétaire peut s'y connecter ;
 * - le compte boss ne fonctionne donc que sur le téléphone du boss ;
 * - un appareil révoqué ou un compte désactivé ne permet plus de connexion.
 */
import { toIso, type Actor, type CoreContext } from '../context';
import { DomainError } from '../errors';
import { toUser, type User } from './types';

export interface AuthResult {
  actor: Actor;
  user: User;
  /**
   * Vrai avec un mot de passe provisoire : l'application doit bloquer l'accès
   * et demander un nouveau mot de passe (`changePassword`) avant toute autre action.
   */
  mustChangePassword: boolean;
}

export async function authenticate(ctx: CoreContext, input: { login: string; password: string }): Promise<AuthResult> {
  const { rows: devices } = await ctx.db.execute('SELECT * FROM device WHERE id = ?', [ctx.device.id]);
  const device = devices[0];
  if (!device) throw new DomainError('FORBIDDEN', "Ce téléphone n'est pas encore relié à une entreprise.");
  if (device.status === 'REVOKED') throw new DomainError('FORBIDDEN', 'Ce téléphone a été révoqué par le boss.');

  const login = (input.login ?? '').trim().toLowerCase();
  const { rows } = await ctx.db.execute('SELECT * FROM user WHERE company_id = ? AND login = ?', [String(device.company_id), login]);
  const row = rows[0];
  if (!row || !(await ctx.passwords.verify(input.password ?? '', String(row.password_hash)))) {
    throw new DomainError('UNAUTHENTICATED', 'Identifiant ou mot de passe incorrect.');
  }
  if (row.id !== device.user_id) throw new DomainError('FORBIDDEN', 'Ce téléphone appartient à un autre utilisateur.');
  if (Number(row.is_active) !== 1) throw new DomainError('FORBIDDEN', 'Ce compte a été désactivé par le boss.');

  // Information locale à l'appareil : pas de seq, elle ne se synchronise pas.
  await ctx.db.execute('UPDATE device SET last_login_at = ? WHERE id = ?', [toIso(ctx.clock.now()), ctx.device.id]);

  const user = toUser(row);
  return {
    actor: { userId: user.id, companyId: user.companyId, role: user.role, deviceId: ctx.device.id },
    user,
    mustChangePassword: user.mustChangePassword,
  };
}
