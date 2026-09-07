// This preload is installed only after the parent observed ENOENT from
// process.cwd(). Assign before Node's worker eval bootstrap asks for cwd.
process.cwd = () => __dirname;
