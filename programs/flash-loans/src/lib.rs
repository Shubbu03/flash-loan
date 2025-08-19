#![allow(unexpected_cfgs, deprecated)]
pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("BxkfU44GdLTBR9LFUDSeK7QtidYN8qiPydbEoiNFfeFM");

#[program]
pub mod flash_loans {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }
}
