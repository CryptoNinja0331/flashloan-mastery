import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as anchor from "@project-serum/anchor";
import { BN, Program } from "@project-serum/anchor";
import {
  getAccount,
  getMint,
  getAssociatedTokenAddress,
  createInitializeMintInstruction,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { FlashLoanMastery } from "../target/types/flash_loan_mastery";
import { expect } from "chai";

describe("flash-loan-mastery", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace
    .FlashLoanMastery as Program<FlashLoanMastery>;
  const wallet = program.provider.publicKey;
  const tokenMint = new Keypair();
  const poolMint = new Keypair();
  const depositor2 = new Keypair();
  const depositor3 = new Keypair();
  let poolAuthorityKey: PublicKey;

  it("init pool", async () => {
    // set up the mint and token accounts
    const mintCost =
      await program.provider.connection.getMinimumBalanceForRentExemption(
        MINT_SIZE,
        "confirmed"
      );
    // create mints
    const instructions = [tokenMint, poolMint].map((it) => [
      SystemProgram.createAccount({
        fromPubkey: wallet,
        lamports: mintCost,
        newAccountPubkey: it.publicKey,
        programId: TOKEN_PROGRAM_ID,
        space: MINT_SIZE,
      }),
      createInitializeMintInstruction(it.publicKey, 9, wallet, wallet),
    ]);
    const tx = new anchor.web3.Transaction().add(...instructions.flat());
    await program.provider.sendAndConfirm(tx, [tokenMint, poolMint]);

    // create pool
    const poolAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("flash_loan"), tokenMint.publicKey.toBuffer()],
      program.programId
    );
    poolAuthorityKey = poolAuthority[0];

    const initPoolIx = await program.methods
      .initPool()
      .accountsStrict({
        funder: wallet,
        mint: tokenMint.publicKey,
        poolShareMint: poolMint.publicKey,
        poolShareMintAuthority: wallet,
        poolAuthority: poolAuthority[0],
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx2 = new anchor.web3.Transaction().add(initPoolIx);
    await program.provider.sendAndConfirm(tx2);

    const poolAuthorityAccount = await program.account.poolAuthority.fetch(
      poolAuthority[0]
    );
    expect(poolAuthorityAccount.bump).eq(poolAuthority[1]);
    expect(poolAuthorityAccount.poolShareMint.equals(poolMint.publicKey)).to.be
      .true;
    expect(poolAuthorityAccount.mint.equals(tokenMint.publicKey)).to.be.true;
  });

  it("deposit into pool", async () => {
    // create token accounts
    const createTokenIxs = [tokenMint, poolMint].map(async (it) => {
      const walletToken = await getAssociatedTokenAddress(it.publicKey, wallet);
      const poolAuthorityToken = await getAssociatedTokenAddress(
        it.publicKey,
        poolAuthorityKey,
        true
      );
      return [
        createAssociatedTokenAccountInstruction(
          wallet,
          walletToken,
          wallet,
          it.publicKey
        ),
        createAssociatedTokenAccountInstruction(
          wallet,
          poolAuthorityToken,
          poolAuthorityKey,
          it.publicKey
        ),
      ];
    });
    // mint token to wallet
    const instructions = (await Promise.all(createTokenIxs)).flat();
    instructions.push(
      createMintToInstruction(
        tokenMint.publicKey,
        await getAssociatedTokenAddress(tokenMint.publicKey, wallet),
        wallet,
        100_000
      )
    );
    // create pool share account for depositor2
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet,
        await getAssociatedTokenAddress(
          poolMint.publicKey,
          depositor2.publicKey
        ),
        depositor2.publicKey,
        poolMint.publicKey
      )
    );
    // create pool share account for depositor3
    instructions.push(
      createAssociatedTokenAccountInstruction(
        wallet,
        await getAssociatedTokenAddress(
          poolMint.publicKey,
          depositor3.publicKey
        ),
        depositor3.publicKey,
        poolMint.publicKey
      )
    );

    await program.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(...instructions)
    );

    const tokenFrom = await getAssociatedTokenAddress(
      tokenMint.publicKey,
      wallet
    );
    const tokenTo = await getAssociatedTokenAddress(
      tokenMint.publicKey,
      poolAuthorityKey,
      true
    );
    const poolShareTokenTo = await getAssociatedTokenAddress(
      poolMint.publicKey,
      wallet
    );
    const poolShareTokenToDepositor2 = await getAssociatedTokenAddress(
      poolMint.publicKey,
      depositor2.publicKey
    );
    const poolShareTokenToDepositor3 = await getAssociatedTokenAddress(
      poolMint.publicKey,
      depositor3.publicKey
    );

    const amount1 = new BN(100);
    const ix = await program.methods
      .deposit(amount1)
      .accountsStrict({
        depositor: wallet,
        tokenFrom,
        tokenTo,
        poolShareTokenTo,
        poolShareMint: poolMint.publicKey,
        poolAuthority: poolAuthorityKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    await program.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(ix)
    );

    let tokenToAccAfter = await getAccount(
      program.provider.connection,
      tokenTo,
      "processed"
    );
    let poolShareTokenToAccAfter = await getAccount(
      program.provider.connection,
      poolShareTokenTo,
      "processed"
    );
    let poolShareMintAccAfter = await getMint(
      program.provider.connection,
      poolMint.publicKey,
      "processed"
    );
    expect(tokenToAccAfter.delegatedAmount).equals(BigInt(amount1.toString()));
    expect(poolShareTokenToAccAfter.amount).equals(BigInt(amount1.toString()));
    expect(poolShareMintAccAfter.supply).equals(BigInt(amount1.toString()));
    // 100% of pool shares
    expect(
      Number(poolShareTokenToAccAfter.amount) /
        Number(poolShareMintAccAfter.supply)
    ).eq(1);

    // deposit again, different account
    const amount2 = new BN(100);
    await program.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        await program.methods
          .deposit(amount2)
          .accountsStrict({
            depositor: wallet,
            tokenFrom,
            tokenTo,
            poolShareTokenTo: poolShareTokenToDepositor2,
            poolShareMint: poolMint.publicKey,
            poolAuthority: poolAuthorityKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction()
      )
    );
    let tokenToAccAfter2 = await getAccount(
      program.provider.connection,
      tokenTo,
      "processed"
    );
    let poolShareTokenToAccAfter2 = await getAccount(
      program.provider.connection,
      poolShareTokenTo,
      "processed"
    );
    let poolShareMintAccAfter2 = await getMint(
      program.provider.connection,
      poolMint.publicKey,
      "processed"
    );
    expect(tokenToAccAfter2.delegatedAmount).equals(
      BigInt(amount1.toString()) + BigInt(amount2.toString())
    );
    // 50% of pool shares
    expect(
      Number(poolShareTokenToAccAfter2.amount) /
        Number(poolShareMintAccAfter2.supply)
    ).eq(0.5);

    // simulate pool profits by transferring directly to pool
    const profits = 77;
    await program.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        createTransferInstruction(tokenFrom, tokenTo, wallet, profits)
      )
    );
    let tokenToAccAfter2b = await getAccount(
      program.provider.connection,
      tokenTo,
      "processed"
    );

    // deposit again, yet another different account
    const amount3 = new BN(33);
    await program.provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        await program.methods
          .deposit(amount3)
          .accountsStrict({
            depositor: wallet,
            tokenFrom,
            tokenTo,
            poolShareTokenTo: poolShareTokenToDepositor3,
            poolShareMint: poolMint.publicKey,
            poolAuthority: poolAuthorityKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .instruction()
      )
    );
    let poolShareTokenToAccAfter3 = await getAccount(
      program.provider.connection,
      poolShareTokenTo,
      "processed"
    );
    let poolShareMintAccAfter3 = await getMint(
      program.provider.connection,
      poolMint.publicKey,
      "processed"
    );

    const depositor3Shares = Math.floor(
      (amount3.toNumber() * Number(poolShareMintAccAfter2.supply)) /
        Number(tokenToAccAfter2b.amount)
    );
    expect(Number(poolShareMintAccAfter3.supply)).equals(
      amount1.add(amount2).toNumber() + depositor3Shares
    );
    // ~44% of pool shares
    expect(
      Number(poolShareTokenToAccAfter3.amount) /
        Number(poolShareMintAccAfter3.supply)
    ).eq(
      100 / Number(poolShareMintAccAfter3.supply)
    );
  });
});
