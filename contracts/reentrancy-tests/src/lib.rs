#![no_std]

use soroban_sdk::{Address, Env, Symbol, Vec, Val, IntoVal, vec};
use soroban_sdk::testutils::{Address as _, Ledger};
use vesting_vault::{Vault, VestingVault, DataKey as VaultDataKey};
use malicious_contract::{AttackState, MaliciousContract, DataKey as MaliciousDataKey};

pub fn run_reentrancy_tests(env: &Env) -> bool {
    let test1_result = test_claim_reentrancy_protection(env);
    let test2_result = test_revoke_reentrancy_protection(env);
    let test3_result = test_create_vault_reentrancy_protection(env);
    let test4_result = test_cei_pattern_protection(env);
    test1_result && test2_result && test3_result && test4_result
}

fn test_claim_reentrancy_protection(env: &Env) -> bool {
    let admin = Address::generate(env);
    let beneficiary = Address::generate(env);
    let attacker = Address::generate(env);

    let vault_contract_id = env.register_contract(None, VestingVault);
    let vault_contract = VestingVaultClient::new(env, &vault_contract_id);

    let malicious_contract_id = env.register_contract(None, MaliciousContract);
    let malicious_contract = MaliciousContractClient::new(env, &malicious_contract_id);

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

    !attack_successful
}

fn test_revoke_reentrancy_protection(env: &Env) -> bool {
    let admin = Address::generate(env);
    let beneficiary = Address::generate(env);

    let vault_contract_id = env.register_contract(None, VestingVault);
    let vault_contract = VestingVaultClient::new(env, &vault_contract_id);

    let malicious_contract_id = env.register_contract(None, MaliciousContract);
    let malicious_contract = MaliciousContractClient::new(env, &malicious_contract_id);

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

    !attack_successful
}

fn test_create_vault_reentrancy_protection(env: &Env) -> bool {
    let admin = Address::generate(env);
    let beneficiary = Address::generate(env);
    let new_beneficiary = Address::generate(env);

    let vault_contract_id = env.register_contract(None, VestingVault);
    let vault_contract = VestingVaultClient::new(env, &vault_contract_id);

    let malicious_contract_id = env.register_contract(None, MaliciousContract);
    let malicious_contract = MaliciousContractClient::new(env, &malicious_contract_id);

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

    !attack_successful
}

fn test_cei_pattern_protection(env: &Env) -> bool {
    let admin = Address::generate(env);
    let beneficiary = Address::generate(env);

    let vault_contract_id = env.register_contract(None, VestingVault);
    let vault_contract = VestingVaultClient::new(env, &vault_contract_id);

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
    final_vault.released_amount == expected_released &&
    final_vault.total_amount == initial_vault.total_amount &&
    claimed_amount > 0
}

pub fn test_normal_operation(env: &Env) -> bool {
    let admin = Address::generate(env);
    let beneficiary = Address::generate(env);

    let vault_contract_id = env.register_contract(None, VestingVault);
    let vault_contract = VestingVaultClient::new(env, &vault_contract_id);

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

    env.ledger().set_timestamp(2000u64);
    let claimed_amount = vault_contract.claim(&vault_id);

    claimed_amount > 0
}

#[derive(Clone)]
pub struct VestingVaultClient<'a> {
    contract_id: &'a Address,
    env: &'a Env,
}

impl<'a> VestingVaultClient<'a> {
    pub fn new(env: &'a Env, contract_id: &'a Address) -> Self {
        Self { contract_id, env }
    }

    pub fn initialize(&self, admin: &Address) {
        self.env.invoke_contract::<()>(
            self.contract_id,
            &Symbol::new(self.env, "initialize"),
            vec![self.env, admin.to_val()],
        );
    }

    pub fn create_vault(
        &self,
        beneficiary: &Address,
        total_amount: &i128,
        cliff_date: &u64,
        vesting_start: &u64,
        vesting_duration: &u64,
        revocable: &bool,
    ) -> Address {
        self.env.invoke_contract::<Address>(
            self.contract_id,
            &Symbol::new(self.env, "create_vault"),
            vec![
                self.env,
                beneficiary.to_val(),
                total_amount.into_val(self.env),
                cliff_date.into_val(self.env),
                vesting_start.into_val(self.env),
                vesting_duration.into_val(self.env),
                revocable.into_val(self.env),
            ],
        )
    }

    pub fn claim(&self, vault_id: &Address) -> i128 {
        self.env.invoke_contract::<i128>(
            self.contract_id,
            &Symbol::new(self.env, "claim"),
            vec![self.env, vault_id.to_val()],
        )
    }

    pub fn revoke(&self, vault_id: &Address) {
        self.env.invoke_contract::<()>(
            self.contract_id,
            &Symbol::new(self.env, "revoke"),
            vec![self.env, vault_id.to_val()],
        );
    }

    pub fn get_vault_info(&self, vault_id: &Address) -> Vault {
        self.env.invoke_contract::<Vault>(
            self.contract_id,
            &Symbol::new(self.env, "get_vault_info"),
            vec![self.env, vault_id.to_val()],
        )
    }
}

#[derive(Clone)]
pub struct MaliciousContractClient<'a> {
    contract_id: &'a Address,
    env: &'a Env,
}

impl<'a> MaliciousContractClient<'a> {
    pub fn new(env: &'a Env, contract_id: &'a Address) -> Self {
        Self { contract_id, env }
    }

    pub fn initialize(&self, vault_contract: &Address, vault_id: &Address) {
        self.env.invoke_contract::<()>(
            self.contract_id,
            &Symbol::new(self.env, "initialize"),
            vec![self.env, vault_contract.to_val(), vault_id.to_val()],
        );
    }

    pub fn attempt_claim_reentrancy(&self) -> bool {
        self.env.invoke_contract::<bool>(
            self.contract_id,
            &Symbol::new(self.env, "attempt_claim_reentrancy"),
            Vec::new(self.env),
        )
    }

    pub fn attempt_revoke_reentrancy(&self) -> bool {
        self.env.invoke_contract::<bool>(
            self.contract_id,
            &Symbol::new(self.env, "attempt_revoke_reentrancy"),
            Vec::new(self.env),
        )
    }

    pub fn attempt_create_vault_reentrancy(&self, beneficiary: &Address) -> bool {
        self.env.invoke_contract::<bool>(
            self.contract_id,
            &Symbol::new(self.env, "attempt_create_vault_reentrancy"),
            vec![self.env, beneficiary.to_val()],
        )
    }

    pub fn get_attack_info(&self) -> AttackState {
        self.env.invoke_contract::<AttackState>(
            self.contract_id,
            &Symbol::new(self.env, "get_attack_info"),
            Vec::new(self.env),
        )
    }

    pub fn reset_attack_state(&self) {
        self.env.invoke_contract::<()>(
            self.contract_id,
            &Symbol::new(self.env, "reset_attack_state"),
            Vec::new(self.env),
        );
    }
}

#[cfg(test)]
mod tests;
