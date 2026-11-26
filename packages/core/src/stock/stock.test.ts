import { beforeEach, describe, expect, it } from 'vitest';

import { listAlerts, markAlertRead } from '../alerts/alerts';
import { updateCompany } from '../accounts/company';
import { createProduct, createService, getItem } from '../catalog/items';
import type { Actor } from '../context';
import { openFiscalYear } from '../fiscal-years/fiscal-years';
import { cancelSale, correctSale, createSale, finalizeSaleOnBoss } from '../sales/sales';
import { createTestContext, type TestContext } from '../testing/context';
import { addEmployee, bootstrapCompany, pairDevice } from '../testing/fixtures';
import {
  computeStock,
  disableStockTracking,
  enableStockTracking,
  getDisplayedStock,
  listStockMovements,
  recordInventory,
  recordStockEntry,
  recordStockLoss,
  setStockAlertThreshold,
} from './stock';

let ctx: TestContext; // téléphone du boss
let boss: Actor;
let paulPhone: TestContext; // même base et même horloge, pour simuler la synchro
let paul: Actor;
let shampoing: string;

beforeEach(async () => {
  ctx = await createTestContext(); // 2026-01-05T08:00Z
  boss = (await bootstrapCompany(ctx)).actor;
  await updateCompany(ctx, boss, { stockEnabled: true });
  await openFiscalYear(ctx, boss, { name: '2026' });
  const employee = await addEmployee(ctx, boss);
  paulPhone = await pairDevice(ctx, boss.companyId, employee.id);
  paul = { userId: employee.id, companyId: boss.companyId, role: 'EMPLOYEE', deviceId: paulPhone.device.id };
  shampoing = (await createProduct(ctx, boss, { name: 'Shampoing', referencePrice: 2500 })).id;
  await enableStockTracking(ctx, boss, shampoing, { initialQuantity: 12 });
});

const at = (hhmm: string) => ctx.clock.set(`2026-01-05T${hhmm}:00.000Z`);
const stock = async (itemId = shampoing) => (await getItem(ctx, boss, itemId)).stockQuantity;
const sell = (phone: TestContext, actor: Actor, quantity: number, itemId = shampoing) =>
  createSale(phone, actor, { lines: [{ itemId, quantity }] });
const receive = (saleId: string) => ctx.db.transaction((tx) => finalizeSaleOnBoss(ctx, tx, saleId));
const movements = async () => (await listStockMovements(ctx, boss, shampoing)).map((m) => [m.type, m.quantityDelta ?? m.countedQuantity]);

describe('activation du suivi', () => {
  it('enregistre la quantité de départ comme un comptage', async () => {
    expect(await stock()).toBe(12);
    expect(await movements()).toEqual([['INVENTORY', 12]]);
  });

  it("exige le module stock activé pour l'entreprise, un produit, et un suivi pas déjà actif", async () => {
    const gel = (await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 })).id;
    const coupe = (await createService(ctx, boss, { name: 'Coupe', referencePrice: 2000 })).id;
    await expect(enableStockTracking(ctx, boss, coupe, { initialQuantity: 1 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(enableStockTracking(ctx, boss, shampoing, { initialQuantity: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await updateCompany(ctx, boss, { stockEnabled: false });
    await expect(enableStockTracking(ctx, boss, gel, { initialQuantity: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('est réservée au boss', async () => {
    await expect(recordStockEntry(ctx, paul, shampoing, { quantity: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(listStockMovements(ctx, paul, shampoing)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('mouvements saisis par le boss', () => {
  it('entrées et pertes s’additionnent', async () => {
    expect(await recordStockEntry(ctx, boss, shampoing, { quantity: 20, reason: 'livraison' })).toBe(32);
    expect(await recordStockLoss(ctx, boss, shampoing, { quantity: 2, reason: 'flacons cassés' })).toBe(30);
    expect(await stock()).toBe(30);
    expect(await movements()).toEqual([
      ['LOSS', -2],
      ['ENTRY', 20],
      ['INVENTORY', 12],
    ]);
  });

  it('un comptage fixe la quantité', async () => {
    await recordStockEntry(ctx, boss, shampoing, { quantity: 20 });
    ctx.clock.advance(60_000);
    expect(await recordInventory(ctx, boss, shampoing, { countedQuantity: 25 })).toBe(25);
  });

  it('refuse un produit non suivi, une quantité nulle, une date future', async () => {
    const gel = (await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 })).id;
    await expect(recordStockEntry(ctx, boss, gel, { quantity: 1 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(recordStockEntry(ctx, boss, shampoing, { quantity: 0 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(recordInventory(ctx, boss, shampoing, { countedQuantity: 5, occurredAt: '2030-01-01T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it("donne un nouveau seq à l'article quand son stock change (les employés le recevront)", async () => {
    const seq = async () => Number((await ctx.db.execute('SELECT seq FROM item WHERE id = ?', [shampoing])).rows[0]?.seq);
    const before = await seq();
    await recordStockEntry(ctx, boss, shampoing, { quantity: 1 });
    expect(await seq()).toBeGreaterThan(before);
  });
});

describe('ventes et stock', () => {
  it('une vente du boss retire la quantité vendue, à l’heure de la vente ; services et produits non suivis ignorés', async () => {
    const gel = (await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 })).id;
    const coupe = (await createService(ctx, boss, { name: 'Coupe', referencePrice: 2000 })).id;
    at('09:00');
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 2 }, { itemId: gel, quantity: 1 }, { itemId: coupe, quantity: 1 }] });
    expect(await stock()).toBe(10);
    const m = (await listStockMovements(ctx, boss, shampoing))[0]!;
    expect(m).toMatchObject({ type: 'SALE', quantityDelta: -2, occurredAt: '2026-01-05T09:00:00.000Z' });
    expect((await ctx.db.execute('SELECT count(*) AS n FROM stock_movement WHERE item_id <> ?', [shampoing])).rows[0]?.n).toBe(0);
  });

  it('une vente d’employé ne touche le stock du boss qu’à la réception', async () => {
    const sale = await sell(paulPhone, paul, 3);
    expect(await stock()).toBe(12);
    await receive(sale.id);
    expect(await stock()).toBe(9);
  });

  describe('scénario de référence : vente hors ligne et comptage', () => {
    it('vente à 9 h reçue à 18 h, comptage à 10 h : le stock reste celui du comptage', async () => {
      at('09:00');
      const sale = await sell(paulPhone, paul, 2); // Paul vend 2 flacons hors ligne
      at('10:00');
      await recordInventory(ctx, boss, shampoing, { countedQuantity: 10 }); // le boss compte 10 sur l'étagère
      at('18:00');
      await receive(sale.id); // la vente de 9 h arrive enfin
      expect(await stock()).toBe(10); // et non 8 : elle était déjà incluse dans le comptage
    });

    it('vente à 11 h, après le comptage : elle est bien retirée', async () => {
      at('10:00');
      await recordInventory(ctx, boss, shampoing, { countedQuantity: 10 });
      at('11:00');
      const sale = await sell(paulPhone, paul, 2);
      at('18:00');
      await receive(sale.id);
      expect(await stock()).toBe(8);
    });

    it("le résultat ne dépend pas de l'ordre d'arrivée", async () => {
      at('09:00');
      const a = await sell(paulPhone, paul, 1);
      at('09:30');
      const b = await sell(paulPhone, paul, 2);
      at('12:00');
      await receive(b.id);
      await receive(a.id);
      const reversed = await stock();
      expect(reversed).toBe(9);
      expect(await computeStock(ctx.db, shampoing)).toBe(reversed);
    });
  });

  it("recevoir deux fois la même vente ne retire qu'une fois", async () => {
    const sale = await sell(paulPhone, paul, 2);
    await receive(sale.id);
    await receive(sale.id);
    expect(await stock()).toBe(10);
    expect((await movements()).filter(([t]) => t === 'SALE')).toHaveLength(1);
  });

  it("une correction enregistre la différence à l'heure où elle est faite, avec son auteur", async () => {
    at('09:00');
    const sale = await sell(paulPhone, paul, 3);
    await receive(sale.id);
    at('15:00');
    await correctSale(ctx, boss, sale.id, { lines: [{ itemId: shampoing, quantity: 1 }], reason: 'erreur de quantité' });
    expect(await stock()).toBe(11);
    expect((await listStockMovements(ctx, boss, shampoing)).slice(0, 2)).toMatchObject([
      { type: 'SALE_CORRECTION', quantityDelta: 2, occurredAt: '2026-01-05T15:00:00.000Z', userId: boss.userId },
      { type: 'SALE', quantityDelta: -3, occurredAt: '2026-01-05T09:00:00.000Z', userId: paul.userId },
    ]);
  });

  it("un article ajouté par une correction sort du stock à l'heure de la correction", async () => {
    const gel = (await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 })).id;
    await enableStockTracking(ctx, boss, gel, { initialQuantity: 5 });
    at('09:00');
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 1 }] });
    at('15:00');
    await correctSale(ctx, boss, sale.id, { lines: [{ itemId: shampoing, quantity: 1 }, { itemId: gel, quantity: 2 }], reason: 'gel oublié' });
    expect((await listStockMovements(ctx, boss, gel))[0]).toMatchObject({ type: 'SALE', quantityDelta: -2, occurredAt: '2026-01-05T15:00:00.000Z' });
  });

  it("remplacer un article par un autre rend le premier et retire le second", async () => {
    const gel = (await createProduct(ctx, boss, { name: 'Gel', referencePrice: 1000 })).id;
    await enableStockTracking(ctx, boss, gel, { initialQuantity: 5 });
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 2 }] });
    await correctSale(ctx, boss, sale.id, { lines: [{ itemId: gel, quantity: 1 }], reason: 'mauvais article' });
    expect(await stock(shampoing)).toBe(12);
    expect(await stock(gel)).toBe(4);
  });

  it("l'annulation rend toute la quantité, à l'heure de l'annulation", async () => {
    at('09:00');
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 2 }] });
    at('11:00');
    await cancelSale(ctx, boss, sale.id, 'double saisie');
    expect(await stock()).toBe(12);
    expect((await listStockMovements(ctx, boss, shampoing))[0]).toMatchObject({
      type: 'SALE_CORRECTION',
      quantityDelta: 2,
      occurredAt: '2026-01-05T11:00:00.000Z',
    });
  });

  it('une annulation après un comptage met le stock à jour à partir de ce comptage', async () => {
    at('09:00');
    const sale = await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 2 }] }); // 10
    at('10:00');
    await recordInventory(ctx, boss, shampoing, { countedQuantity: 10 });
    at('11:00');
    await cancelSale(ctx, boss, sale.id, 'retour de la cliente'); // les 2 flacons reviennent après le comptage
    expect(await stock()).toBe(12);
  });

  it("une vente annulée sur le téléphone de l'employé avant réception ne touche jamais le stock", async () => {
    const sale = await sell(paulPhone, paul, 2);
    await cancelSale(paulPhone, paul, sale.id, 'client parti');
    await receive(sale.id);
    expect(await stock()).toBe(12);
    expect(await movements()).toEqual([['INVENTORY', 12]]);
  });

  it('le stock peut devenir négatif : la vente n’est jamais bloquée', async () => {
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 15 }] });
    expect(await stock()).toBe(-3);
  });
});

describe('alertes de stock (boss seulement)', () => {
  it("alerte quand le stock devient bas, puis négatif — une seule fois par passage", async () => {
    await setStockAlertThreshold(ctx, boss, shampoing, 5);
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 7 }] }); // 5 : bas
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 1 }] }); // 4 : toujours bas, pas de nouvelle alerte
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 6 }] }); // -2 : négatif
    expect((await listAlerts(ctx, boss)).map((a) => [a.type, a.message])).toEqual([
      ['NEGATIVE_STOCK', 'Stock négatif pour « Shampoing » : -2.'],
      ['LOW_STOCK', 'Stock bas pour « Shampoing » : 5.'],
    ]);
  });

  it('sans seuil, alerte à zéro ; nouvelle alerte si le stock redescend après être remonté', async () => {
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 12 }] }); // 0
    await recordStockEntry(ctx, boss, shampoing, { quantity: 10 }); // 10 : redevient normal
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 10 }] }); // 0 à nouveau
    expect((await listAlerts(ctx, boss)).map((a) => a.type)).toEqual(['LOW_STOCK', 'LOW_STOCK']);
  });

  it("pas d'alerte quand le module stock est désactivé pour l'entreprise", async () => {
    await updateCompany(ctx, boss, { stockEnabled: false });
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 20 }] });
    expect(await listAlerts(ctx, boss)).toEqual([]);
  });

  it('marque une alerte comme lue ; réservé au boss', async () => {
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 12 }] });
    const [alert] = await listAlerts(ctx, boss, { unreadOnly: true });
    await markAlertRead(ctx, boss, alert!.id);
    expect(await listAlerts(ctx, boss, { unreadOnly: true })).toEqual([]);
    await expect(listAlerts(ctx, paul)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe("stock affiché sur le téléphone de l'employé", () => {
  it('stock reçu moins ses ventes en attente ; ni compté deux fois ni oublié après réception', async () => {
    const sale = await sell(paulPhone, paul, 3);
    expect((await getDisplayedStock(paulPhone, paul))[shampoing]).toBe(9);
    expect((await getDisplayedStock(ctx, boss))[shampoing]).toBe(12); // le boss n'a encore rien reçu

    await receive(sale.id); // le boss reçoit : son stock passe à 9, la vente n'est plus en attente
    expect((await getDisplayedStock(paulPhone, paul))[shampoing]).toBe(9);
    expect((await getDisplayedStock(ctx, boss))[shampoing]).toBe(9);
  });

  it('une vente en attente annulée ne compte pas', async () => {
    const sale = await sell(paulPhone, paul, 3);
    await cancelSale(paulPhone, paul, sale.id, 'erreur');
    expect((await getDisplayedStock(paulPhone, paul))[shampoing]).toBe(12);
  });
});

describe('arrêt du suivi', () => {
  it('les ventes ne créent plus de mouvement ; un nouveau départ repart d’un comptage', async () => {
    await disableStockTracking(ctx, boss, shampoing);
    await createSale(ctx, boss, { lines: [{ itemId: shampoing, quantity: 4 }] });
    expect((await movements()).filter(([t]) => t === 'SALE')).toHaveLength(0);
    const item = await enableStockTracking(ctx, boss, shampoing, { initialQuantity: 7 });
    expect(item).toMatchObject({ isStockTracked: true, stockQuantity: 7 });
  });
});
