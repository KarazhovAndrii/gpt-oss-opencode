from app.__main__ import main


def test_json_output(capsys):
    assert main(["tests/fixtures/census_small.csv", "--format", "json"]) == 0
