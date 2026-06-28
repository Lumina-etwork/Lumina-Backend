#[cfg(test)]
mod tests {
    use soroban_sdk::{Env, Address};
    use soroban_sdk::testutils::{Address as _, Ledger};
    use crate::run_reentrancy_tests;
    use crate::test_normal_operation as run_normal_operation;
    use vesting_vault::VestingVault;
    use malicious_contract::MaliciousContract;
    use crate::{VestingVaultClient, MaliciousContractClient};

    #[test]
    fn test_comprehensive_reentrancy_protection() {
        let env = Env::default();

        let all_tests_passed = run_reentrancy_tests(&env);

        assert!(all_tests_passed, "All reentrancy protection tests should pass");
    }

    #[test]
    fn test_normal_operation() {
        let env = Env::default();

        let normal_op_works = run_normal_operation(&env);

        assert!(normal_op_works, "Normal operation should work correctly");
    }

    #[test]
    fn test_claim_reentrancy_protection() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let beneficiary = Address::generate(&env);

        let vault_contract_id = env.register_contract(None, VestingVault);
        let vault_contract = VestingVaultClient::new(&env, &vault_contract_id);

        let malicious_contract_id = env.register_contract(None, MaliciousContract);
        let malicious_contract = MaliciousContractClient::new(&env, &malicious_contract_id);

        env.mock_all_auths();
        vault_contract.initialize(&admin);

        let vault_id = vault_contract.create_vault(
            &beneficiary,
            &1000i128,
            &1000u64,
            &1000u64,
            &1000u64,
            &true
        );

        malicious_contract.initialize(&vault_contract_id, &vault_id);

        env.ledger().set_timestamp(2000u64);

        let attack_successful = malicious_contract.attempt_claim_reentrancy();

        assert!(!attack_successful, "Reentrancy attack should be blocked");

        let attack_info = malicious_contract.get_attack_info();
        assert!(attack_info.attack_count > 0, "Attack should have been attempted");
        assert!(!attack_info.reentrancy_successful, "Reentrancy should not be successful");
    }

    #[test]
    fn test_revoke_reentrancy_protection() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let beneficiary = Address::generate(&env);

        let vault_contract_id = env.register_contract(None, VestingVault);
        let vault_contract = VestingVaultClient::new(&env, &vault_contract_id);

        let malicious_contract_id = env.register_contract(None, MaliciousContract);
        let malicious_contract = MaliciousContractClient::new(&env, &malicious_contract_id);

        env.mock_all_auths();
        vault_contract.initialize(&admin);

        let vault_id = vault_contract.create_vault(
            &beneficiary,
            &1000i128,
            &1000u64,
            &1000u64,
            &1000u64,
            &true
        );

        malicious_contract.initialize(&vault_contract_id, &vault_id);

        env.ledger().set_timestamp(2000u64);

        let attack_successful = malicious_contract.attempt_revoke_reentrancy();

        assert!(!attack_successful, "Reentrancy attack should be blocked");

        let attack_info = malicious_contract.get_attack_info();
        assert!(attack_info.attack_count > 0, "Attack should have been attempted");
        assert!(!attack_info.reentrancy_successful, "Reentrancy should not be successful");
    }

    #[test]
    fn test_create_vault_reentrancy_protection() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let beneficiary = Address::generate(&env);
        let new_beneficiary = Address::generate(&env);

        let vault_contract_id = env.register_contract(None, VestingVault);
        let vault_contract = VestingVaultClient::new(&env, &vault_contract_id);

        let malicious_contract_id = env.register_contract(None, MaliciousContract);
        let malicious_contract = MaliciousContractClient::new(&env, &malicious_contract_id);

        env.mock_all_auths();
        vault_contract.initialize(&admin);

        let vault_id = vault_contract.create_vault(
            &beneficiary,
            &1000i128,
            &1000u64,
            &1000u64,
            &1000u64,
            &true
        );

        malicious_contract.initialize(&vault_contract_id, &vault_id);

        env.ledger().set_timestamp(2000u64);

        let attack_successful = malicious_contract.attempt_create_vault_reentrancy(&new_beneficiary);

        assert!(!attack_successful, "Reentrancy attack should be blocked");

        let attack_info = malicious_contract.get_attack_info();
        assert!(attack_info.attack_count > 0, "Attack should have been attempted");
        assert!(!attack_info.reentrancy_successful, "Reentrancy should not be successful");
    }

    #[test]
    fn test_cei_pattern_state_consistency() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let beneficiary = Address::generate(&env);

        let vault_contract_id = env.register_contract(None, VestingVault);
        let vault_contract = VestingVaultClient::new(&env, &vault_contract_id);

        env.mock_all_auths();
        vault_contract.initialize(&admin);

        let vault_id = vault_contract.create_vault(
            &beneficiary,
            &1000i128,
            &1000u64,
            &1000u64,
            &1000u64,
            &true
        );

        let initial_vault = vault_contract.get_vault_info(&vault_id);

        env.ledger().set_timestamp(2000u64);

        let claimed_amount = vault_contract.claim(&vault_id);

        let final_vault = vault_contract.get_vault_info(&vault_id);

        let expected_released = initial_vault.released_amount + claimed_amount;
        assert_eq!(
            final_vault.released_amount,
            expected_released,
            "Released amount should be consistent"
        );
        assert_eq!(
            final_vault.total_amount,
            initial_vault.total_amount,
            "Total amount should not change"
        );
        assert!(claimed_amount > 0, "Should have claimed some tokens");
    }

    #[test]
    fn test_multiple_claims_state_consistency() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let beneficiary = Address::generate(&env);

        let vault_contract_id = env.register_contract(None, VestingVault);
        let vault_contract = VestingVaultClient::new(&env, &vault_contract_id);

        env.mock_all_auths();
        vault_contract.initialize(&admin);

        let vault_id = vault_contract.create_vault(
            &beneficiary,
            &1000i128,
            &1000u64,
            &1000u64,
            &2000u64,
            &true
        );

        env.ledger().set_timestamp(1500u64);
        let first_claim = vault_contract.claim(&vault_id);

        env.ledger().set_timestamp(3000u64);
        let second_claim = vault_contract.claim(&vault_id);

        let final_vault = vault_contract.get_vault_info(&vault_id);

        let total_claimed = first_claim + second_claim;
        assert_eq!(
            final_vault.released_amount,
            total_claimed,
            "Total released should equal sum of claims"
        );
        assert_eq!(
            final_vault.released_amount,
            final_vault.total_amount,
            "Should have claimed all tokens"
        );
    }
}
