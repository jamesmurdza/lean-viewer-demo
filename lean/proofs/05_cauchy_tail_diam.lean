import Mathlib

/-
Let (aₙ)ₙ₋₁ be a Cauchy sequence in a metric space (M, d), and for
n ≥ 1 define the "tail set"
  Aₙ := {a_k : k ≥ n}.

Claim: lim_{n→∞} diam(Aₙ) = 0.

Idea: Cauchy means for every ε > 0 there's an N past which all pairwise
distances are < ε. For n ≥ N, every two points of Aₙ are among those
tail terms, so diam(Aₙ) ≤ ε. Since this holds for every ε > 0, the
diameters tend to 0.

We index sequences by ℕ (0-based) instead of starting at 1 — the "n ≥ 1"
in the statement is just a labeling convention, not part of the math.
-/

open Metric Filter
open scoped Topology

variable {M : Type*} [PseudoMetricSpace M]

/-- The tail set `Aₙ = {a_k : k ≥ n}` of a sequence, as the image of
`Set.Ici n` under `a`. -/
def tailSet (a : ℕ → M) (n : ℕ) : Set M :=
  a '' Set.Ici n

theorem tendsto_diam_tailSet_of_cauchySeq {a : ℕ → M} (ha : CauchySeq a) :
    Tendsto (fun n => diam (tailSet a n)) atTop (𝓝 0) := by
  rw [Metric.tendsto_atTop]
  intro ε hε
  -- Cauchy: eventually (past some N) all pairwise distances are < ε / 2.
  obtain ⟨N, hN⟩ := Metric.cauchySeq_iff.1 ha (ε / 2) (by linarith)
  refine ⟨N, fun n hn => ?_⟩
  -- For n ≥ N, every pair of points in Aₙ = tailSet a n comes from
  -- indices k, l ≥ n ≥ N, so their distance is < ε / 2 ≤ ε.
  have hbound : diam (tailSet a n) ≤ ε / 2 := by
    apply diam_le_of_forall_dist_le (by linarith)
    rintro x ⟨k, hk, rfl⟩ y ⟨l, hl, rfl⟩
    have hk' : n ≤ k := hk
    have hl' : n ≤ l := hl
    exact le_of_lt (hN k (le_trans hn hk') l (le_trans hn hl'))
  rw [Real.dist_eq, sub_zero, abs_of_nonneg diam_nonneg]
  linarith
