import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { FlashLoans } from "../target/types/flash_loans";
import {
    PublicKey,
    Keypair,
    SystemProgram,
    Transaction,
    SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createMint,
    createAssociatedTokenAccount,
    mintTo,
    getAssociatedTokenAddress,
    getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("Flash Loans", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.FlashLoans as Program<FlashLoans>;

    // Test accounts
    let mint: PublicKey;
    let protocolPda: PublicKey;
    let protocolBump: number;
    let protocolAta: PublicKey;
    let borrower: Keypair;
    let borrowerAta: PublicKey;

    // Test amounts
    const INITIAL_SUPPLY = new BN(1_000_000 * 10 ** 6); // 1M tokens with 6 decimals
    const BORROW_AMOUNT = new BN(10_000 * 10 ** 6);     // 10K tokens
    const FEE_RATE = 500; // 5% (500 basis points)

    before("Set up test environment", async () => {
        borrower = Keypair.generate();

        await provider.connection.confirmTransaction(
            await provider.connection.requestAirdrop(borrower.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL)
        );

        mint = await createMint(
            provider.connection,
            provider.wallet.payer,
            provider.wallet.publicKey,
            null,
            6 // 6 decimals
        );

        [protocolPda, protocolBump] = PublicKey.findProgramAddressSync(
            [Buffer.from("protocol")],
            program.programId
        );

        protocolAta = await getAssociatedTokenAddress(mint, protocolPda, true); // allowOwnerOffCurve = true

        try {
            await createAssociatedTokenAccount(
                provider.connection,
                provider.wallet.payer,
                mint,
                protocolPda,
                undefined, // confirmOptions
                TOKEN_PROGRAM_ID,
                ASSOCIATED_TOKEN_PROGRAM_ID,
                true // allowOwnerOffCurve
            );
        } catch (error) {
            console.log("Protocol ATA creation result:", error.message);
        }

        await mintTo(
            provider.connection,
            provider.wallet.payer,
            mint,
            protocolAta,
            provider.wallet.publicKey,
            INITIAL_SUPPLY.toNumber()
        );

        borrowerAta = await getAssociatedTokenAddress(mint, borrower.publicKey);

        await createAssociatedTokenAccount(
            provider.connection,
            provider.wallet.payer,
            mint,
            borrower.publicKey
        );

        const feeBuffer = BORROW_AMOUNT.muln(500).divn(10_000).muln(10); // 10x the fee amount for safety
        await mintTo(
            provider.connection,
            provider.wallet.payer,
            mint,
            borrowerAta,
            provider.wallet.publicKey,
            feeBuffer.toNumber()
        );
    });

    describe("Positive Test Cases", () => {
        it("Should successfully execute a flash loan with proper repayment", async () => {
            const borrowIx = await program.methods
                .borrow(BORROW_AMOUNT)
                .accountsPartial({
                    borrower: borrower.publicKey,
                    protocol: protocolPda,
                    mint: mint,
                    borrowerAta: borrowerAta,
                    protocolAta: protocolAta,
                    sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .instruction();

            const repayIx = await program.methods
                .repay()
                .accountsPartial({
                    borrower: borrower.publicKey,
                    protocol: protocolPda,
                    mint: mint,
                    borrowerAta: borrowerAta,
                    protocolAta: protocolAta,
                    sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .instruction();

            const tx = new Transaction().add(borrowIx, repayIx);

            // Execute transaction
            await provider.sendAndConfirm(tx, [borrower]);

            const protocolAccount = await getAccount(provider.connection, protocolAta);
            const expectedFee = BORROW_AMOUNT.muln(FEE_RATE).divn(10_000);
            const expectedBalance = INITIAL_SUPPLY.add(expectedFee);

            expect(protocolAccount.amount.toString()).to.equal(expectedBalance.toString());
        });

        it("Should handle multiple flash loans in sequence", async () => {
            const borrowAmount1 = new BN(5_000 * 10 ** 6);
            const borrowAmount2 = new BN(3_000 * 10 ** 6);

            // First flash loan
            const tx1 = new Transaction().add(
                await program.methods
                    .borrow(borrowAmount1)
                    .accountsPartial({
                        borrower: borrower.publicKey,
                        protocol: protocolPda,
                        mint: mint,
                        borrowerAta: borrowerAta,
                        protocolAta: protocolAta,
                        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    })
                    .instruction(),
                await program.methods
                    .repay()
                    .accountsPartial({
                        borrower: borrower.publicKey,
                        protocol: protocolPda,
                        mint: mint,
                        borrowerAta: borrowerAta,
                        protocolAta: protocolAta,
                        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    })
                    .instruction()
            );

            await provider.sendAndConfirm(tx1, [borrower]);

            // Second flash loan
            const tx2 = new Transaction().add(
                await program.methods
                    .borrow(borrowAmount2)
                    .accountsPartial({
                        borrower: borrower.publicKey,
                        protocol: protocolPda,
                        mint: mint,
                        borrowerAta: borrowerAta,
                        protocolAta: protocolAta,
                        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    })
                    .instruction(),
                await program.methods
                    .repay()
                    .accountsPartial({
                        borrower: borrower.publicKey,
                        protocol: protocolPda,
                        mint: mint,
                        borrowerAta: borrowerAta,
                        protocolAta: protocolAta,
                        sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                        tokenProgram: TOKEN_PROGRAM_ID,
                        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                        systemProgram: SystemProgram.programId,
                    })
                    .instruction()
            );

            await provider.sendAndConfirm(tx2, [borrower]);

            // Verify cumulative fees
            const protocolAccount = await getAccount(provider.connection, protocolAta);
            const totalFees = borrowAmount1.add(borrowAmount2).add(BORROW_AMOUNT).muln(FEE_RATE).divn(10_000);
            const expectedBalance = INITIAL_SUPPLY.add(totalFees);

            expect(protocolAccount.amount.toString()).to.equal(expectedBalance.toString());
        });
    });

    describe("Negative Test Cases", () => {
        it("Should fail when borrowing zero amount", async () => {
            try {
                const tx = new Transaction().add(
                    await program.methods
                        .borrow(new BN(0))
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction(),
                    await program.methods
                        .repay()
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction()
                );

                await provider.sendAndConfirm(tx, [borrower]);
                expect.fail("Should have failed with InvalidAmount error");
            } catch (error) {
                expect(error.message).to.include("Invalid amount");
            }
        });

        it("Should fail when missing repay instruction", async () => {
            try {
                const tx = new Transaction().add(
                    await program.methods
                        .borrow(BORROW_AMOUNT)
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction()
                );

                await provider.sendAndConfirm(tx, [borrower]);
                expect.fail("Should have failed with MissingRepayIx error");
            } catch (error) {
                expect(error.message).to.match(/(Missing repay instruction|custom program error|0x1775|6005)/);
            }
        });

        it("Should fail when borrow is not the first instruction", async () => {
            try {
                const dummyIx = SystemProgram.transfer({
                    fromPubkey: borrower.publicKey,
                    toPubkey: borrower.publicKey,
                    lamports: 0,
                });

                const tx = new Transaction().add(
                    dummyIx,
                    await program.methods
                        .borrow(BORROW_AMOUNT)
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction(),
                    await program.methods
                        .repay()
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction()
                );

                await provider.sendAndConfirm(tx, [borrower]);
                expect.fail("Should have failed with InvalidIx error");
            } catch (error) {
                expect(error.message).to.include("Invalid instruction");
            }
        });

        it("Should fail when insufficient funds for repayment", async () => {
            const poorBorrower = Keypair.generate();
            await provider.connection.confirmTransaction(
                await provider.connection.requestAirdrop(poorBorrower.publicKey, anchor.web3.LAMPORTS_PER_SOL)
            );

            const poorBorrowerAta = await getAssociatedTokenAddress(mint, poorBorrower.publicKey);

            try {
                const tx = new Transaction().add(
                    await program.methods
                        .borrow(BORROW_AMOUNT)
                        .accountsPartial({
                            borrower: poorBorrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: poorBorrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction(),
                    await program.methods
                        .repay()
                        .accountsPartial({
                            borrower: poorBorrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: poorBorrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction()
                );

                await provider.sendAndConfirm(tx, [poorBorrower]);
                expect.fail("Should have failed due to insufficient funds");
            } catch (error) {
                expect(error.message).to.include("insufficient");
            }
        });

        it("Should fail when borrowing more than protocol has", async () => {
            const excessiveAmount = INITIAL_SUPPLY.muln(2);

            try {
                const tx = new Transaction().add(
                    await program.methods
                        .borrow(excessiveAmount)
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction(),
                    await program.methods
                        .repay()
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction()
                );

                await provider.sendAndConfirm(tx, [borrower]);
                expect.fail("Should have failed due to insufficient protocol funds");
            } catch (error) {
                expect(error.message).to.include("insufficient");
            }
        });
    });

    describe("Edge Cases and Security Tests", () => {
        it("Should correctly calculate fees for various amounts", async () => {
            const testAmounts = [
                new BN(1_000 * 10 ** 6),   // 1K tokens
                new BN(100_000 * 10 ** 6), // 100K tokens
                new BN(1),               // 1 token unit (minimum)
            ];

            for (const amount of testAmounts) {
                const requiredFee = amount.muln(FEE_RATE).divn(10_000);
                const safetyBuffer = requiredFee.muln(2); // 2x safety buffer

                await mintTo(
                    provider.connection,
                    provider.wallet.payer,
                    mint,
                    borrowerAta,
                    provider.wallet.publicKey,
                    safetyBuffer.toNumber()
                );

                const initialBalance = await getAccount(provider.connection, protocolAta);

                const tx = new Transaction().add(
                    await program.methods
                        .borrow(amount)
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction(),
                    await program.methods
                        .repay()
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction()
                );

                await provider.sendAndConfirm(tx, [borrower]);

                const finalBalance = await getAccount(provider.connection, protocolAta);
                const expectedFee = amount.muln(FEE_RATE).divn(10_000);
                const actualIncrease = new BN(finalBalance.amount.toString()).sub(new BN(initialBalance.amount.toString()));

                expect(actualIncrease.toString()).to.equal(expectedFee.toString());
            }
        });

        it("Should prevent overflow in fee calculation", async () => {
            const nearMaxAmount = new BN("18446744073709551615");

            try {
                const tx = new Transaction().add(
                    await program.methods
                        .borrow(nearMaxAmount)
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction(),
                    await program.methods
                        .repay()
                        .accountsPartial({
                            borrower: borrower.publicKey,
                            protocol: protocolPda,
                            mint: mint,
                            borrowerAta: borrowerAta,
                            protocolAta: protocolAta,
                            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
                            tokenProgram: TOKEN_PROGRAM_ID,
                            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
                            systemProgram: SystemProgram.programId,
                        })
                        .instruction()
                );

                await provider.sendAndConfirm(tx, [borrower]);
                expect.fail("Should have failed due to overflow or insufficient funds");
            } catch (error) {
                expect(error.message).to.match(/(overflow|insufficient)/i);
            }
        });
    });
});
