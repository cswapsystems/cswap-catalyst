use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/primitive/bytearray
use cardano/address.{Address}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, OutputReference, Transaction}
use ebecca/amm_helpers.{has_one}
use ebecca/dex_types.{
  Advance, AdvanceBootstrap, FactoryDatum, FactoryStateAction, SetPaused,
}

/// Administrator-controlled factory state.
///
/// This UTxO is consumed only when a new pool is created. It is otherwise a
/// reference input, so swaps and LP operations do not contend on it.
/// The shared offer validator address is supplied at deployment. Its script
/// binds the Team-approved bootstrap-pool creation path.
validator factory_state(
  admin: VerificationKeyHash,
  bootstrap_offer_address: Address,
) {
  spend(
    datum_opt: Option<FactoryDatum>,
    action: FactoryStateAction,
    own_ref: OutputReference,
    self: Transaction,
  ) {
    expect Some(before) = datum_opt
    expect Some(own_input) =
      list.find(self.inputs, fn(input) { input.output_reference == own_ref })
    expect [continuing] =
      list.filter(
        self.outputs,
        fn(output) {
          output.address == own_input.output.address && has_one(
            output.value,
            before.factory_token,
          )
        },
      )
    expect InlineDatum(raw_after) = continuing.datum
    expect after: FactoryDatum = raw_after

    and {
      when action is {
        AdvanceBootstrap -> and {
            list.has(self.extra_signatories, admin),
            list.any(
              self.inputs,
              fn(input: Input) {
                input.output.address == bootstrap_offer_address
              },
            ),
          }
        _ -> list.has(self.extra_signatories, admin)
      },
      before.admin == admin,
      has_one(own_input.output.value, before.factory_token),
      after.factory_token == before.factory_token,
      after.admin == before.admin,
      after.pool_nft_policy == before.pool_nft_policy,
      when action is {
        Advance -> and {
            !before.paused,
            after.paused == before.paused,
            after.next_pool_id == before.next_pool_id + 1,
            assets.quantity_of(
              self.mint,
              before.pool_nft_policy,
              bytearray.from_int_big_endian(before.next_pool_id, 8),
            ) == 1,
          }
        AdvanceBootstrap -> and {
            !before.paused,
            after.paused == before.paused,
            after.next_pool_id == before.next_pool_id + 1,
            assets.quantity_of(
              self.mint,
              before.pool_nft_policy,
              bytearray.from_int_big_endian(before.next_pool_id, 8),
            ) == 1,
          }
        SetPaused { paused } -> and {
            after.next_pool_id == before.next_pool_id,
            after.paused == paused,
          }
      },
    }
  }

  else(_) {
    False
  }
}
