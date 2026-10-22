import Mathlib

-- Mathlib's `ring` tactic normalizes both sides of a commutative
-- (semi)ring equation and checks they match — no manual algebra needed.
example (a b : ℝ) : (a + b) ^ 2 = a ^ 2 + 2 * a * b + b ^ 2 := by ring
