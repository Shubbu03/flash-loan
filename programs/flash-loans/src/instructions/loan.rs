use anchor_lang::{
    prelude::*,
    solana_program::{
        hash::hash,
        sysvar::instructions::{
            load_current_index_checked, load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID,
        },
    },
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer, Mint, Token, TokenAccount, Transfer},
};

use crate::error::FlashLoanError;

#[derive(Accounts)]
pub struct Loan<'info> {
    #[account(mut)]
    pub borrower: Signer<'info>,

    #[account(
        seeds = [b"protocol".as_ref()],
        bump,
    )]
    pub protocol: SystemAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = borrower,
        associated_token::mint = mint,
        associated_token::authority = borrower,
    )]
    pub borrower_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = protocol,
    )]
    pub protocol_ata: Account<'info, TokenAccount>,

    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: InstructionsSysvar account
    pub sysvar_instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Loan<'info> {
    pub fn borrow(&mut self, borrow_amount: u64, protocol_bump: u8) -> Result<()> {
        //verify valid amount
        require!(borrow_amount > 0, FlashLoanError::InvalidAmount);

        //define vars for signed transfer -> protocol pda to user pda (ata for both)
        let token_program = self.token_program.to_account_info();

        let accounts = Transfer {
            from: self.protocol_ata.to_account_info(),
            to: self.borrower_ata.to_account_info(),
            authority: self.protocol.to_account_info(),
        };
        let seeds = &[b"protocol".as_ref(), &[protocol_bump]];
        let signer_seeds = &[&seeds[..]];

        //cpi context
        let cpi_ctx = CpiContext::new_with_signer(token_program, accounts, signer_seeds);

        //transfer
        transfer(cpi_ctx, borrow_amount)?;

        //instruction introspection - looking into further ix before they even run
        let ixs = self.sysvar_instructions.to_account_info();

        //repay ix checks
        let current_index = load_current_index_checked(&ixs)?;
        require_eq!(current_index, 0, FlashLoanError::InvalidIx);

        // checking how many instruction we have in this transaction
        let instruction_sysvar = ixs.try_borrow_data()?;
        let len = u16::from_le_bytes(instruction_sysvar[0..2].try_into().unwrap());

        // ensuring we have a repay ix
        if let Ok(repay_ix) = load_instruction_at_checked(len as usize - 1, &ixs) {
            // ix checks
            require_keys_eq!(
                repay_ix.program_id,
                crate::ID,
                FlashLoanError::InvalidProgram
            );
            // checking if this is a repay instruction by checking the discriminator
            // For Anchor programs, the discriminator is the first 8 bytes
            let repay_discriminator: [u8; 8] =
                hash(b"global:repay").to_bytes()[..8].try_into().unwrap();
            require!(
                repay_ix.data[0..8].eq(&repay_discriminator),
                FlashLoanError::InvalidIx
            );

            // We could check the Wallet and Mint separately but by checking the ATA we do this automatically
            require_keys_eq!(
                repay_ix
                    .accounts
                    .get(3)
                    .ok_or(FlashLoanError::InvalidBorrowerAta)?
                    .pubkey,
                self.borrower_ata.key(),
                FlashLoanError::InvalidBorrowerAta
            );
            require_keys_eq!(
                repay_ix
                    .accounts
                    .get(4)
                    .ok_or(FlashLoanError::InvalidProtocolAta)?
                    .pubkey,
                self.protocol_ata.key(),
                FlashLoanError::InvalidProtocolAta
            );
        } else {
            return Err(FlashLoanError::MissingRepayIx.into());
        }

        Ok(())
    }

    pub fn repay(&mut self) -> Result<()> {
        let ixs = self.sysvar_instructions.to_account_info();

        let mut amount_borrowed: u64;

        if let Ok(borrow_ix) = load_instruction_at_checked(0, &ixs) {
            // checking the amount borrowed
            let mut borrowed_data: [u8; 8] = [0u8; 8];
            borrowed_data.copy_from_slice(&borrow_ix.data[8..16]);
            amount_borrowed = u64::from_le_bytes(borrowed_data)
        } else {
            return Err(FlashLoanError::MissingBorrowIx.into());
        }

        // adding the fee to the amount borrowed (In our case we hardcoded it to 500 basis point)
        let fee = (amount_borrowed as u128)
            .checked_mul(500)
            .unwrap()
            .checked_div(10_000)
            .ok_or(FlashLoanError::Overflow)? as u64;
        amount_borrowed = amount_borrowed
            .checked_add(fee)
            .ok_or(FlashLoanError::Overflow)?;

        // transfering the funds from the protocol to the borrower
        transfer(
            CpiContext::new(
                self.token_program.to_account_info(),
                Transfer {
                    from: self.borrower_ata.to_account_info(),
                    to: self.protocol_ata.to_account_info(),
                    authority: self.borrower.to_account_info(),
                },
            ),
            amount_borrowed,
        )?;
        Ok(())
    }
}
