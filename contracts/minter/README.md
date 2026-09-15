# CSWAP RWA minting and fractionalization

The vault datum records the original owner and configured recovery administrator. `Withdraw` requires burning the complete fraction supply. `EmergencyRecover` accepts only a positive partial burn, requires the recovery administrator signature, and pays the original RWA only to its recorded owner.

Emergency recovery closes the vault. Fractions not burned have no future redemption claim, so operations must revoke that exact fraction unit from the marketplace registry and retire its AMM liquidity.
