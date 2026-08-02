import { CustomerModel, HpAgreementModel, HpScheduleModel } from '../models/index.js';
import { addMonthsClamped } from '../domain/loans.js';
import { formatGhs } from './money.js';
import { audit } from './audit.js';
import { emitAdminEvent } from './realtime.js';
import { enqueueSms } from './sms.js';
import { logger } from './logger.js';

/**
 * Automatic HP arrears (user-confirmed rule): an instalment unpaid ONE
 * MONTH past its due date puts the agreement in arrears. State-based and
 * idempotent — repossession itself stays a human decision at the office.
 */
export async function runHpArrearsPass(): Promise<{ flagged: number }> {
  const cutoff = addMonthsClamped(new Date(), -1);
  let flagged = 0;

  const overdue = await HpScheduleModel.find({
    status: { $ne: 'paid' },
    dueDate: { $lt: cutoff },
  }).distinct('agreementId');
  if (overdue.length === 0) return { flagged };

  const agreements = await HpAgreementModel.find({ _id: { $in: overdue }, status: 'active' });
  for (const agreement of agreements) {
    const upd = await HpAgreementModel.updateOne(
      { _id: agreement._id, status: 'active' },
      { $set: { status: 'in-arrears', arrearsAt: new Date() } },
    );
    if (upd.modifiedCount !== 1) continue;
    flagged++;

    await audit({
      actorId: agreement.customerId, // system action; anchored on the customer
      action: 'hp.agreement.arrears',
      entityType: 'hp-agreement',
      entityId: agreement._id,
      after: { trigger: 'installment ≥1 month overdue' },
    });
    const customer = await CustomerModel.findById(agreement.customerId);
    if (customer) {
      await enqueueSms({
        to: customer.phone,
        template: 'hp-arrears-warning',
        message:
          `Yadah: your hire purchase payment for ${agreement.itemSnapshot.name} is more than a month ` +
          `overdue (balance ${formatGhs((agreement.totalPayable ?? 0) - (agreement.totalPaid - agreement.depositRequired))}). ` +
          `Please visit the office to avoid repossession.`,
        relatedEntityType: 'hp-agreement',
        relatedEntityId: agreement._id,
      });
    }
    emitAdminEvent('hp.arrears', {
      id: agreement._id.toHexString(),
      customerId: agreement.customerId.toHexString(),
      item: agreement.itemSnapshot.name,
    });
  }

  if (flagged > 0) logger.info({ flagged }, 'hp arrears pass flagged agreements');
  return { flagged };
}

let timer: NodeJS.Timeout | null = null;

export function startHpArrearsWorker(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  const run = (): void => {
    runHpArrearsPass().catch((err: unknown) => {
      logger.warn({ err }, 'hp arrears pass errored');
    });
  };
  run();
  timer = setInterval(run, intervalMs);
  timer.unref();
}

export function stopHpArrearsWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
