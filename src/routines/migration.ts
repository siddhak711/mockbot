/**
 * The routines tables live in the tracked migration 017_agent_grants_and_routines.
 * This repair stays on attach: an ownerless routine is adopted by the earliest
 * account's lead once that lead exists, which can be after the schema ran.
 * It touches only rows whose user_id is still NULL.
 */
export const ADOPT_OWNERLESS_ROUTINES = `
UPDATE routines AS routine
SET user_id = owner.id,
    agent_id = owner.lead_id,
    updated_at = NOW()
FROM (
  SELECT users.id AS id,
         (
           SELECT agents.id
           FROM agents
           WHERE agents.user_id = users.id
             AND agents.is_lead = TRUE
           ORDER BY agents.created_at ASC, agents.id ASC
           LIMIT 1
         ) AS lead_id
  FROM users
  ORDER BY users.created_at ASC, users.id ASC
  LIMIT 1
) AS owner
WHERE routine.user_id IS NULL
  AND owner.lead_id IS NOT NULL
`;
