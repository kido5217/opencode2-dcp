{
  description = "opencode-dcp — DCP ported to OpenCode v2 (nix dev environment)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f (nixpkgs.legacyPackages.${system}));
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # Node major pinned here (flake, not ambient environment);
          # @opencode/plugin@2.0.7 declares no `engines` constraint.
          # nodejs bundles npm.
          packages = [ pkgs.nodejs_24 ];

          # TS toolchain (typescript, tsx, tsup, prettier) comes from
          # package.json devDependencies via npm ci — single source of
          # truth, no nixpkgs mirror that could skew versions.
          shellHook = ''
            if [ ! -d node_modules ]; then
              echo "opencode-dcp devShell: installing dev dependencies (npm ci)"
              npm ci
            fi
          '';
        };
      });
    };
}
