/**
 * Billing detail pane — the `billing` tile. Billing (Stripe) is Phase 2 and blocked on external
 * accounts, so this is the SAME stub the old Settings showed: the current plan + a disabled
 * "Manage subscription" button. No new feature — the scope fence (PLAN › Non-goals) holds until
 * the billing lane unparks. Reads the account store so the plan badge stays live.
 */
import { type ReactElement } from 'react'
import { useAccountStore } from '../../../store/accountStore'
import { pane } from '../paneStyles'

export function BillingPane(): ReactElement {
  const status = useAccountStore((s) => s.status)
  const plan = useAccountStore((s) => s.plan)
  const isPro = plan === 'pro'

  return (
    <div style={pane.section}>
      <div style={pane.acctRow} data-test="billing-plan-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.acctEmail}>{isPro ? 'Pro plan' : 'Free plan'}</div>
          <div style={pane.acctSub}>
            {status === 'signed-in'
              ? isPro
                ? 'Full access · thanks for supporting Expanse.'
                : 'Upgrade to Pro when billing opens.'
              : 'Sign in to see your plan and billing.'}
          </div>
        </div>
        <span style={isPro ? pane.badgePro : pane.badgeFree}>{isPro ? 'PRO' : 'FREE'}</span>
      </div>
      <div style={pane.row}>
        <button
          className="ca-btn-ghost"
          disabled
          title="Available when billing ships (Phase 2)"
          data-test="billing-manage"
        >
          Manage subscription
        </button>
      </div>
      <p style={pane.hint}>
        Plans, credits, and payment arrive with billing. Nothing is charged today.
      </p>
    </div>
  )
}
