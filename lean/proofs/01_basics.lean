import Mathlib

-- A basic proof, no Mathlib needed: addition on ℕ is commutative.
def add (a b : Nat) : Nat := a + b

theorem add_comm_test (a b : Nat) : add a b = add b a := by
  unfold add
  exact Nat.add_comm a b

#eval add 2 3
#check add_comm_test

open Nat in
#check Nat.add_comm
