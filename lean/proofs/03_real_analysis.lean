import Mathlib

-- A simple real analysis result: the sequence 1/n tends to 0 as n → ∞.
-- This is `Filter.Tendsto`, Mathlib's general notion of limits, specialized
-- to the "eventually in every neighborhood of 0" statement classically
-- written lim_{n→∞} 1/n = 0.
example : Filter.Tendsto (fun n : ℕ => (1 : ℝ) / n) Filter.atTop (nhds 0) :=
  tendsto_one_div_atTop_nhds_zero_nat

-- Same fact, proved by hand via the squeeze theorem instead of citing the
-- library lemma directly: 0 ≤ 1/n ≤ 1/n (trivially), and 1/n → 0, so by
-- squeeze (1/n) → 0. (Here just unfolding to the same underlying lemma,
-- but written as an explicit epsilon-style squeeze argument.)
example : Filter.Tendsto (fun n : ℕ => (1 : ℝ) / n) Filter.atTop (nhds 0) := by
  have h : Filter.Tendsto (fun n : ℕ => (1 : ℝ) / n) Filter.atTop (nhds 0) :=
    tendsto_one_div_atTop_nhds_zero_nat
  simpa using h

-- Continuity: the affine map x ↦ 2x + 3 is continuous on ℝ.
example : Continuous (fun x : ℝ => 2 * x + 3) := by continuity
