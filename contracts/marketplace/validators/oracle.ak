use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/interval
use cardano/transaction.{InlineDatum, OutputReference, Transaction, find_input}
use ebecca/types.{OracleDatum, has_one, quote_is_sane}

pub type OracleRedeemer {
  Update { next: OracleDatum }
  Close
}

fn datum_is(output_datum: Data, expected: OracleDatum) -> Bool {
  expect datum: OracleDatum = output_datum
  datum == expected
}

fn quote_list_is_sane(datum: OracleDatum) -> Bool {
  and {
    list.all(datum.policy_quotes, fn(entry) { quote_is_sane(entry.quote) }),
    list.all(datum.asset_quotes, fn(entry) { quote_is_sane(entry.quote) }),
  }
}

validator oracle(operator: VerificationKeyHash) {
  spend(
    datum: Option<OracleDatum>,
    redeemer: OracleRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(current) = datum
    expect Some(own_input) = tx.inputs |> find_input(own_ref)

    let signed_by_operator = list.has(tx.extra_signatories, operator)
    let input_has_oracle_token =
      own_input.output.value |> has_one(current.oracle_token)

    when redeemer is {
      Update { next } -> {
        let continuing_oracle_output =
          list.any(
            tx.outputs,
            fn(output) {
              and {
                output.address == own_input.output.address,
                output.value == own_input.output.value,
                output.value |> has_one(current.oracle_token),
                when output.datum is {
                  InlineDatum(data) -> datum_is(data, next)
                  _ -> False
                },
              }
            },
          )

        and {
          signed_by_operator,
          input_has_oracle_token,
          next.oracle_token == current.oracle_token,
          next.quote == current.quote,
          next.sequence > current.sequence,
          next.valid_until > 0,
          tx.validity_range |> interval.is_entirely_before(next.valid_until),
          quote_list_is_sane(next),
          continuing_oracle_output,
        }
      }

      Close -> and {
          signed_by_operator,
          input_has_oracle_token,
        }
    }
  }

  else(_) {
    fail
  }
}
