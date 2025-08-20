#![allow(unexpected_cfgs, deprecated)]
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use instructions::*;

declare_id!("BxkfU44GdLTBR9LFUDSeK7QtidYN8qiPydbEoiNFfeFM");

#[program]
pub mod flash_loans {
    use super::*;

    pub fn borrow(ctx: Context<Loan>, borrow_amount: u64) -> Result<()> {
        ctx.accounts.borrow(borrow_amount, ctx.bumps.protocol)
    }

    pub fn repay(ctx: Context<Loan>) -> Result<()> {
        ctx.accounts.repay()
    }
}
